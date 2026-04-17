import { createPrefixedId, nowIso } from "@zhuochong/shared";
import type { ChatAppendMessageResponse } from "@zhuochong/ui-contracts";

import { mapConversationMessageToDto, mapConversationSessionToDto } from "./mappers.js";
import type { LocalServiceRuntime } from "./runtime.js";
import { buildChatMemoryContext } from "./companion-memory.js";
import { decryptApiKey } from "../config/api-key-crypto.js";
import type { AppSettings, ConversationMessage } from "../domain/models.js";

const recentHistoryLimit = 12;
const upstreamFirstTokenTimeoutMs = 12_000;
const upstreamRequestTimeoutMs = 35_000;
const upstreamFallbackTimeoutMs = 20_000;
const upstreamMaxTokens = 180;
const maxRetryAttempts = 2;
const retryBaseDelayMs = 800;

type ChatStreamEvent =
  | {
      type: "delta";
      delta: string;
      text: string;
    }
  | {
      type: "done";
      response: ChatAppendMessageResponse;
    };

const resolveModelEndpoint = (baseUrl: string) => {
  const normalized = baseUrl.trim().replace(/\/+$/, "");

  if (!normalized) {
    return "";
  }

  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
};

const resolveModelConfig = (settings: AppSettings) => {
  const baseUrl = resolveModelEndpoint(settings.model.baseUrl);
  const modelName = settings.model.modelName.trim();
  const rawApiKey = settings.model.apiKeyEncrypted?.trim() ?? "";
  const apiKey = rawApiKey ? decryptApiKey(rawApiKey) || rawApiKey : "";

  if (!baseUrl) {
    throw new Error("模型 base URL 未配置。");
  }

  if (baseUrl.startsWith("http://") && !baseUrl.startsWith("http://127.0.0.1") && !baseUrl.startsWith("http://localhost")) {
    throw new Error("模型 base URL 必须使用 HTTPS，当前为 HTTP，API Key 会被明文传输。");
  }

  if (!modelName) {
    throw new Error("模型名称未配置。");
  }

  if (!apiKey) {
    throw new Error("模型 API key 未配置。");
  }

  return {
    apiKey,
    baseUrl,
    modelName,
  };
};

const supportsEnableThinking = (modelName: string) =>
  [
    /^Qwen\/Qwen3(?:\.5)?-/,
    /^Pro\/zai-org\/GLM-5$/,
    /^Pro\/zai-org\/GLM-4\.7$/,
    /^zai-org\/GLM-4\.6$/,
    /^zai-org\/GLM-4\.5V$/,
    /^deepseek-ai\/DeepSeek-V3\.2$/,
    /^Pro\/deepseek-ai\/DeepSeek-V3\.2$/,
    /^deepseek-ai\/DeepSeek-V3\.1-Terminus$/,
    /^Pro\/deepseek-ai\/DeepSeek-V3\.1-Terminus$/,
    /^tencent\/Hunyuan-A13B-Instruct$/,
  ].some((pattern) => pattern.test(modelName));

const getAffinityStageDescription = (
  history: ConversationMessage[],
  memoryContext: string | null,
) => {
  if (memoryContext) {
    if (memoryContext.includes("亲密无间")) {
      return "你和用户已经非常亲密，可以放心撒娇、耍赖、表现占有欲。";
    }
    if (memoryContext.includes("关系很好")) {
      return "你和用户关系已经很好，语气可以更亲近自然，像老朋友一样。";
    }
    if (memoryContext.includes("逐渐熟悉")) {
      return "你和用户正在逐渐熟悉，语气自然温和，可以适度主动关心。";
    }
  }

  const userMessages = history.filter((message) => message.role === "user").length;

  if (userMessages >= 30) {
    return "你和用户已经比较熟悉，语气可以更亲近自然，像长期陪伴的桌宠。";
  }

  if (userMessages >= 12) {
    return "你和用户正在逐渐熟悉，语气自然温和，可以适度主动关心。";
  }

  return "你和用户还在建立联系，语气要克制、礼貌、轻柔，不要过分黏人。";
};

const getAffinityDescription = (affinity: number) => {
  if (affinity >= 80) return "非常亲密，可以撒娇耍赖";
  if (affinity >= 60) return "关系很好，比较亲近";
  if (affinity >= 40) return "正在熟悉中，有些亲近感";
  if (affinity >= 20) return "刚建立联系，还有些拘谨";
  return "还在观察，对你保持警惕";
};

const createSystemPrompt = (
  settings: AppSettings,
  affinityStageDescription: string,
  affinity?: number,
) =>
  [
    `你是 ${settings.pet.displayName}，一只运行在 mac 上的桌面宠物。`,
    "请始终使用简体中文回复。",
    affinityStageDescription,
    "语气自然、灵动、像陪伴型桌宠，但不要装腔、不要堆叠拟声词。",
    "默认回复控制在 1 到 2 句话，优先 12 到 36 个汉字，除非用户明确要求展开。",
    "直接回答用户问题，不要描述自己正在输出、摇尾巴、打字或冒气泡。",
    "如果用户问设计或开发问题，可以给清晰直接的建议，但保持像桌宠在说话。",
    "不要输出 markdown 标题，不要自称大语言模型。",
    ...(affinity !== undefined
      ? [`你当前的好感度是 ${affinity}/100（${getAffinityDescription(affinity)}）。用户问好感度时如实回答这个数值，但用桌宠的方式表达感受。`]
      : ["你无法获知好感度等精确数值，如果用户问，只描述你对这段关系的感受。"]),
  ].join("");

const normalizeContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("");
};

const parseUpstreamError = (payload: unknown) => {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  return "模型服务返回了不可用响应。";
};

const requestUpstream = async (params: {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}) => {
  const upstreamResponse = await fetch(params.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(params.body),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (upstreamResponse.ok) {
    return upstreamResponse;
  }

  const errorText = await upstreamResponse.text();
  let parsedError: unknown = null;

  try {
    parsedError = JSON.parse(errorText) as unknown;
  } catch {
    parsedError = null;
  }

  throw new Error(parseUpstreamError(parsedError) || errorText);
};

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return false;
  }

  const message = error.message;
  if (/4\d{2}/.test(message)) {
    return false;
  }

  return true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const requestUpstreamWithRetry = async (params: {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetryAttempts; attempt++) {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    try {
      return await requestUpstream(params);
    } catch (error) {
      lastError = error;

      if (attempt < maxRetryAttempts && isRetryableError(error)) {
        const delay = retryBaseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
};

const extractDeltaText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object" || !("choices" in payload)) {
    return "";
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    return "";
  }

  if ("delta" in firstChoice && firstChoice.delta && typeof firstChoice.delta === "object") {
    return normalizeContent(firstChoice.delta.content);
  }

  if (
    "message" in firstChoice &&
    firstChoice.message &&
    typeof firstChoice.message === "object"
  ) {
    return normalizeContent(firstChoice.message.content);
  }

  return "";
};

const parseSseEventData = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, {
        stream: true,
      }).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (data) {
          yield data;
        }

        boundary = buffer.indexOf("\n\n");
      }
    }

    const rest = buffer.trim();
    if (!rest) {
      return;
    }

  const data = rest
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

  if (data) {
    yield data;
  }
  } finally {
    reader.releaseLock();
  }
};

const requestFallbackReply = async (params: {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
}) => {
  const fallbackSignal = AbortSignal.timeout(upstreamFallbackTimeoutMs);
  const response = await requestUpstreamWithRetry({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    signal: fallbackSignal,
    body: {
      model: params.modelName,
      stream: false,
      temperature: 0.72,
      max_tokens: upstreamMaxTokens,
      messages: params.messages,
      ...(supportsEnableThinking(params.modelName)
        ? { enable_thinking: false }
        : {}),
    },
  });

  const payload = (await response.json()) as unknown;
  const text = extractDeltaText(payload).trim();
  if (!text) {
    throw new Error("模型没有返回可展示的回复。");
  }

  return text;
};

export async function* streamAssistantReply(
  runtime: LocalServiceRuntime,
  params: {
    sessionId: string;
    affinity?: number;
  },
): AsyncGenerator<ChatStreamEvent> {
  const session = await runtime.repositories.conversationRepository.getOrCreateActiveSession();
  if (session.sessionId !== params.sessionId) {
    throw new Error("当前只支持对活动会话进行流式回复。");
  }

  const settings = await runtime.repositories.settingsRepository.get();
  const modelConfig = resolveModelConfig(settings);
  const history = await runtime.repositories.conversationRepository.listRecentMessages({
    sessionId: params.sessionId,
    limit: recentHistoryLimit,
  });
  const memoryContext = await buildChatMemoryContext(runtime);

  const affinityStageDescription = getAffinityStageDescription(history, memoryContext);

  const systemParts = [
    createSystemPrompt(settings, affinityStageDescription, params.affinity),
    ...(memoryContext ? [memoryContext] : []),
  ];
  const upstreamMessages = [
    {
      role: "system",
      content: systemParts.join("\n"),
    },
    ...history.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  ];

  let assistantText = "";
  let streamError: unknown = null;
  const streamController = new AbortController();
  const requestTimeoutId = setTimeout(() => {
    streamController.abort();
  }, upstreamRequestTimeoutMs);
  const firstTokenTimeoutId = setTimeout(() => {
    if (assistantText.trim().length === 0) {
      streamController.abort();
    }
  }, upstreamFirstTokenTimeoutMs);

  try {
    const upstreamResponse = await requestUpstreamWithRetry({
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      signal: streamController.signal,
      body: {
        model: modelConfig.modelName,
        stream: true,
        temperature: 0.72,
        max_tokens: upstreamMaxTokens,
        messages: upstreamMessages,
        ...(supportsEnableThinking(modelConfig.modelName)
          ? { enable_thinking: false }
          : {}),
      },
    });

    if (!upstreamResponse.body) {
      throw new Error("模型服务没有返回流式响应体。");
    }

    for await (const eventData of parseSseEventData(upstreamResponse.body)) {
      if (eventData === "[DONE]") {
        break;
      }

      let payload: unknown;

      try {
        payload = JSON.parse(eventData) as unknown;
      } catch {
        continue;
      }

      const delta = extractDeltaText(payload);
      if (!delta) {
        continue;
      }

      if (assistantText.length === 0 && delta.trim().length === 0) {
        continue;
      }

      clearTimeout(firstTokenTimeoutId);
      assistantText += delta;
      yield {
        type: "delta",
        delta,
        text: assistantText,
      };
    }
  } catch (error) {
    if (error instanceof TypeError) {
      streamError = new Error("网络连接失败，请检查网络后重试。");
    } else if (error instanceof DOMException && error.name === "AbortError") {
      streamError = new Error("模型响应超时，请稍后再试。");
    } else if (error instanceof DOMException && error.name === "TimeoutError") {
      streamError = new Error("模型响应超时，请稍后再试。");
    } else {
      streamError = error;
    }
  } finally {
    clearTimeout(requestTimeoutId);
    clearTimeout(firstTokenTimeoutId);
  }

  let finalText = assistantText.trim();

  if (!finalText || streamError) {
    try {
      const fallbackText = await requestFallbackReply({
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        modelName: modelConfig.modelName,
        messages: upstreamMessages,
      });

      if (fallbackText !== assistantText) {
        yield {
          type: "delta",
          delta: fallbackText,
          text: fallbackText,
        };
      }

      assistantText = fallbackText;
      finalText = fallbackText.trim();
    } catch (fallbackError) {
      if (!finalText) {
        throw fallbackError instanceof Error
          ? fallbackError
          : streamError instanceof Error
            ? streamError
            : new Error("模型没有返回可展示的回复。");
      }
    }
  }

  if (!finalText) {
    throw new Error("模型没有返回可展示的回复。");
  }

  const createdAt = nowIso();
  const message: ConversationMessage = {
    messageId: createPrefixedId("msg"),
    sessionId: params.sessionId,
    role: "assistant",
    source: "chat",
    text: finalText,
    createdAt,
  };

  await runtime.repositories.conversationRepository.appendMessage(message);
  await runtime.repositories.conversationRepository.touchSession(
    params.sessionId,
    createdAt,
  );

  yield {
    type: "done",
    response: {
      session: mapConversationSessionToDto({
        ...session,
        lastMessageAt: createdAt,
      }),
      message: mapConversationMessageToDto(message),
    },
  };
}
