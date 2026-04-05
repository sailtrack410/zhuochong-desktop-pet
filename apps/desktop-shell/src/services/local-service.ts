import { z } from "zod";

import {
  chatAppendMessageRequestSchema,
  chatAppendMessageResponseSchema,
  chatAppendMessageResultSchema,
  chatHistoryQuerySchema,
  chatHistoryResultSchema,
  chatSessionResultSchema,
  diaryGetQuerySchema,
  diaryListQuerySchema,
  diaryListResultSchema,
  diaryGetResultSchema,
  memoryListQuerySchema,
  memoryListResultSchema,
  petStateSnapshotResultSchema,
  reminderCreateRequestSchema,
  reminderCreateResultSchema,
  petStateUpdateRequestSchema,
  reminderAcknowledgeRequestSchema,
  reminderAcknowledgeResultSchema,
  reminderRuntimeStatusResultSchema,
  settingsResultSchema,
  settingsUpdateRequestSchema,
  createContractResultSchema,
  type ChatAppendMessageRequest,
  type ChatAppendMessageResponse,
  type ChatHistoryDto,
  type ChatHistoryQuery,
  type ChatSessionDto,
  type DiaryEntryDto,
  type DiaryListDto,
  type DiaryGetQuery,
  type MemoryListDto,
  type MemoryListQuery,
  type PetStateSnapshot,
  type PetStateUpdateRequest,
  type ReminderCreateRequest,
  type ReminderCreateResponse,
  type ReminderAcknowledgeRequest,
  type ReminderAcknowledgeResponse,
  type ReminderListDto,
  type ReminderListQuery,
  type ReminderRuntimeStatusDto,
  type SettingsDto,
  type SettingsUpdateRequest,
} from "@zhuochong/ui-contracts";

type LocalServiceBootstrap = {
  settings?: SettingsDto;
  petState?: PetStateSnapshot;
  activeSession?: ChatSessionDto;
  status: {
    level: "online" | "degraded";
    label: string;
  };
};

type LocalServiceStreamEvent =
  | {
      type: "started";
      requestId: string;
    }
  | {
      type: "delta";
      delta: string;
      text: string;
    }
  | {
      type: "done";
      data: ChatAppendMessageResponse;
    }
  | {
      type: "error";
      message: string;
    };

const localServiceHealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("local-service"),
  storage: z.union([
    z.object({
      mode: z.literal("sqlite"),
      databaseFilePath: z.string(),
    }),
    z.object({
      mode: z.literal("memory"),
      fallbackFrom: z.literal("sqlite").optional(),
      reason: z.string().optional(),
    }),
  ]),
  issuedAt: z.string().datetime(),
});

const localServiceStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("delta"),
    delta: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    data: chatAppendMessageResponseSchema,
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

const reminderRecordDtoSchema = z.object({
  reminderId: z.string().min(1),
  category: z.enum(["companion", "task", "status", "emotional"]),
  source: z.enum(["time", "battery", "weather", "idle", "calendar", "manual"]),
  priority: z.enum(["low", "medium", "high"]),
  status: z.enum(["pending", "ready", "dismissed", "opened_chat", "suppressed"]),
  text: z.string().min(1),
  triggeredAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime().optional(),
  suppressionReason: z.string().optional(),
});

const reminderListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
});

const reminderListResultSchema = createContractResultSchema(
  z.object({
    reminders: z.array(reminderRecordDtoSchema),
    total: z.number().int().nonnegative(),
  }),
);

const getBridge = () => window.zhuochong?.localService;

const getLocalServiceBaseUrl = () =>
  window.zhuochong?.localService.baseUrl ?? "http://127.0.0.1:3765";
const localStreamTimeoutMs = 45_000;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "local-service 未响应。";

const unwrapContract = <TData>(
  payload: unknown,
  schema: z.ZodTypeAny,
  endpoint: string,
): TData => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`${endpoint} 返回结构不合法。`);
  }

  if (!parsed.data.ok) {
    throw new Error(parsed.data.error.message);
  }

  return parsed.data.data as TData;
};

const formatSessionId = (sessionId: string): string =>
  sessionId.length > 14
    ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
    : sessionId;

const parseSettledContract = <TData>(
  settled: PromiseSettledResult<unknown>,
  schema: z.ZodTypeAny,
  endpoint: string,
): { data?: TData; error?: string } => {
  if (settled.status !== "fulfilled") {
    return {
      error: getErrorMessage(settled.reason),
    };
  }

  try {
    return {
      data: unwrapContract<TData>(settled.value, schema, endpoint),
    };
  } catch (error) {
    return {
      error: getErrorMessage(error),
    };
  }
};

const parseSseEventData = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
};

export const desktopLocalService = {
  async getBootstrap(): Promise<LocalServiceBootstrap> {
    const bridge = getBridge();
    if (!bridge) {
      return {
        status: {
          level: "degraded",
          label: "Desktop bridge 不可用，未接入 local-service。",
        },
      };
    }

    const [healthSettled, settingsSettled, petStateSettled, sessionSettled] =
      await Promise.allSettled([
        bridge.getHealth(),
        bridge.getSettings(),
        bridge.getPetState(),
        bridge.getActiveChatSession(),
      ]);

    const health =
      healthSettled.status === "fulfilled"
        ? localServiceHealthSchema.safeParse(healthSettled.value)
        : null;

    const settings = parseSettledContract<SettingsDto>(
      settingsSettled,
      settingsResultSchema,
      "settings/get",
    );
    const petState = parseSettledContract<PetStateSnapshot>(
      petStateSettled,
      petStateSnapshotResultSchema,
      "pet/state",
    );
    const activeSession = parseSettledContract<ChatSessionDto>(
      sessionSettled,
      chatSessionResultSchema,
      "chat/session/active",
    );

    const bootstrapData = {
      ...(settings.data ? { settings: settings.data } : {}),
      ...(petState.data ? { petState: petState.data } : {}),
      ...(activeSession.data ? { activeSession: activeSession.data } : {}),
    };

    if (!health || !health.success) {
      return {
        ...bootstrapData,
        status: {
          level: "degraded",
          label:
            healthSettled.status === "rejected"
              ? getErrorMessage(healthSettled.reason)
              : "local-service 健康检查返回结构不合法。",
        },
      };
    }

    const sessionLabel = activeSession.data
      ? ` · 会话 ${formatSessionId(activeSession.data.sessionId)}`
      : "";
    const baseLabel =
      health.data.storage.mode === "sqlite"
        ? `local-service 已连接 · sqlite${sessionLabel}`
        : `local-service 已连接 · memory${sessionLabel}`;

    const hasPartialFailure = Boolean(
      settings.error || petState.error || activeSession.error,
    );

    return {
      ...bootstrapData,
      status: {
        level: hasPartialFailure ? "degraded" : "online",
        label: hasPartialFailure
          ? `${baseLabel} · 部分接口未就绪`
          : baseLabel,
      },
    };
  },

  async updatePetState(
    request: PetStateUpdateRequest,
  ): Promise<PetStateSnapshot> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法同步桌宠状态。");
    }

    const payload = petStateUpdateRequestSchema.parse(request);
    const result = await bridge.updatePetState(payload);
    return unwrapContract<PetStateSnapshot>(
      result,
      petStateSnapshotResultSchema,
      "pet/state/update",
    );
  },

  async getActiveChatSession(): Promise<ChatSessionDto> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法读取活动会话。");
    }

    return unwrapContract<ChatSessionDto>(
      await bridge.getActiveChatSession(),
      chatSessionResultSchema,
      "chat/session/active",
    );
  },

  async createNewSession(): Promise<ChatSessionDto> {
    const response = await fetch(`${getLocalServiceBaseUrl()}/chat/session/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error("创建新会话失败。");
    }

    return unwrapContract<ChatSessionDto>(
      await response.json(),
      chatSessionResultSchema,
      "chat/session/new",
    );
  },

  async getSessionStats(sessionId: string): Promise<{ messageCount: number; userTokens: number; assistantTokens: number }> {
    const params = new URLSearchParams({ sessionId });
    const response = await fetch(`${getLocalServiceBaseUrl()}/chat/session/stats?${params.toString()}`);

    if (!response.ok) {
      throw new Error("获取会话统计失败。");
    }

    const resultSchema = z.object({
      ok: z.literal(true),
      data: z.object({
        messageCount: z.number(),
        userTokens: z.number(),
        assistantTokens: z.number(),
      }),
      meta: z.object({
        requestId: z.string(),
      }).optional(),
    });

    return unwrapContract(
      await response.json(),
      resultSchema,
      "chat/session/stats",
    );
  },

  async getChatHistory(query: ChatHistoryQuery): Promise<ChatHistoryDto> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法读取聊天历史。");
    }

    const parsed = chatHistoryQuerySchema.parse(query);
    const payload = {
      sessionId: parsed.sessionId,
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.beforeMessageId
        ? { beforeMessageId: parsed.beforeMessageId }
        : {}),
    };
    return unwrapContract<ChatHistoryDto>(
      await bridge.getChatHistory(payload),
      chatHistoryResultSchema,
      "chat/history",
    );
  },

  async appendChatMessage(
    request: ChatAppendMessageRequest,
  ): Promise<ChatAppendMessageResponse> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法写入聊天消息。");
    }

    const payload = chatAppendMessageRequestSchema.parse(request);
    return unwrapContract<ChatAppendMessageResponse>(
      await bridge.appendChatMessage(payload),
      chatAppendMessageResultSchema,
      "chat/messages/append",
    );
  },

  async streamAssistantReply(params: {
    sessionId: string;
    onDelta: (text: string) => void;
  }): Promise<ChatAppendMessageResponse> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, localStreamTimeoutMs);

    let response: Response;

    try {
      response = await fetch(`${getLocalServiceBaseUrl()}/chat/respond/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: params.sessionId,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      window.clearTimeout(timeoutId);
      throw error instanceof DOMException && error.name === "AbortError"
        ? new Error("桌宠这次开口太慢了，稍后再试。")
        : error;
    }

    if (!response.ok) {
      window.clearTimeout(timeoutId);
      const text = await response.text();
      try {
        const payload = JSON.parse(text) as {
          error?: {
            message?: string;
          };
        };
        throw new Error(payload.error?.message ?? "流式回复请求失败。");
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error("流式回复请求失败。");
      }
    }

    if (!response.body) {
      window.clearTimeout(timeoutId);
      throw new Error("本地服务没有返回流式响应。");
    }

    try {
      for await (const rawData of parseSseEventData(response.body)) {
        let payload: unknown;

        try {
          payload = JSON.parse(rawData) as unknown;
        } catch {
          continue;
        }

        const parsed = localServiceStreamEventSchema.safeParse(payload);
        if (!parsed.success) {
          continue;
        }

        const event: LocalServiceStreamEvent = parsed.data;

        if (event.type === "delta") {
          params.onDelta(event.text);
          continue;
        }

        if (event.type === "done") {
          return event.data;
        }

        if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } catch (error) {
      throw error instanceof DOMException && error.name === "AbortError"
        ? new Error("桌宠这次开口太慢了，稍后再试。")
        : error;
    } finally {
      window.clearTimeout(timeoutId);
    }

    throw new Error("流式回复意外中断。");
  },

  async getSettings(): Promise<SettingsDto> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法读取设置。");
    }

    return unwrapContract<SettingsDto>(
      await bridge.getSettings(),
      settingsResultSchema,
      "settings/get",
    );
  },

  async updateSettings(request: SettingsUpdateRequest): Promise<SettingsDto> {
    const payload = settingsUpdateRequestSchema.parse(request);

    const response = await fetch(`${getLocalServiceBaseUrl()}/settings/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errorMsg = "更新设置失败";
      try {
        const errorData = await response.json() as { error?: { message?: string } };
        if (errorData.error?.message) {
          errorMsg = errorData.error.message;
        }
      } catch {
        // 忽略 JSON 解析错误
      }
      throw new Error(errorMsg);
    }

    return unwrapContract<SettingsDto>(
      await response.json(),
      settingsResultSchema,
      "settings/update",
    );
  },

  async getMemoryList(query?: MemoryListQuery): Promise<MemoryListDto> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法读取记忆列表。");
    }

    const parsed = memoryListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new Error("记忆列表查询参数无效。");
    }

    const params = new URLSearchParams();
    if (parsed.data.category) {
      params.set("category", parsed.data.category);
    }
    if (parsed.data.limit) {
      params.set("limit", String(parsed.data.limit));
    }

    const url = `${getLocalServiceBaseUrl()}/memory/list?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("获取记忆列表失败。");
    }

    return unwrapContract<MemoryListDto>(
      await response.json(),
      memoryListResultSchema,
      "memory/list",
    );
  },

  async getDiaryList(limit?: number): Promise<DiaryListDto> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法读取日记列表。");
    }

    const parsed = diaryListQuerySchema.safeParse({ limit });
    if (!parsed.success) {
      throw new Error("日记列表查询参数无效。");
    }

    const params = new URLSearchParams();
    if (parsed.data.limit) {
      params.set("limit", String(parsed.data.limit));
    }

    const url = `${getLocalServiceBaseUrl()}/diary/list?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("获取日记列表失败。");
    }

    return unwrapContract<DiaryListDto>(
      await response.json(),
      diaryListResultSchema,
      "diary/list",
    );
  },

  async getDiaryByDate(query: DiaryGetQuery): Promise<DiaryEntryDto | null> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Desktop bridge 不可用，无法读取日记。");
    }

    const parsed = diaryGetQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new Error("日记查询参数无效。");
    }

    const params = new URLSearchParams({
      date: parsed.data.date,
    });

    const url = `${getLocalServiceBaseUrl()}/diary/get?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("获取日记失败。");
    }

    return unwrapContract<DiaryEntryDto | null>(
      await response.json(),
      diaryGetResultSchema,
      "diary/get",
    );
  },

  async getReminderList(query?: ReminderListQuery): Promise<ReminderListDto> {
    const parsed = reminderListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new Error("提醒列表查询参数无效。");
    }

    const params = new URLSearchParams();
    if (parsed.data.limit) {
      params.set("limit", String(parsed.data.limit));
    }
    if (parsed.data.since) {
      params.set("since", parsed.data.since);
    }

    const url = `${getLocalServiceBaseUrl()}/reminder/list?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("获取提醒列表失败。");
    }

    return unwrapContract<ReminderListDto>(
      await response.json(),
      reminderListResultSchema,
      "reminder/list",
    );
  },

  async getReminderRuntimeStatus(): Promise<ReminderRuntimeStatusDto> {
    const bridge = getBridge();
    if (bridge?.getReminderRuntimeStatus) {
      return unwrapContract<ReminderRuntimeStatusDto>(
        await bridge.getReminderRuntimeStatus(),
        reminderRuntimeStatusResultSchema,
        "reminder/runtime-status",
      );
    }

    const response = await fetch(
      `${getLocalServiceBaseUrl()}/reminder/runtime-status`,
    );
    if (!response.ok) {
      throw new Error("获取提醒运行状态失败。");
    }

    return unwrapContract<ReminderRuntimeStatusDto>(
      await response.json(),
      reminderRuntimeStatusResultSchema,
      "reminder/runtime-status",
    );
  },

  async createReminder(
    request: ReminderCreateRequest,
  ): Promise<ReminderCreateResponse> {
    const payload = reminderCreateRequestSchema.parse(request);
    const response = await fetch(`${getLocalServiceBaseUrl()}/reminder/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error("创建提醒失败。");
    }

    return unwrapContract<ReminderCreateResponse>(
      await response.json(),
      reminderCreateResultSchema,
      "reminder/create",
    );
  },

  async acknowledgeReminder(
    request: ReminderAcknowledgeRequest,
  ): Promise<ReminderAcknowledgeResponse> {
    const payload = reminderAcknowledgeRequestSchema.parse(request);
    const bridge = getBridge();
    if (bridge?.acknowledgeReminder) {
      return unwrapContract<ReminderAcknowledgeResponse>(
        await bridge.acknowledgeReminder(payload),
        reminderAcknowledgeResultSchema,
        "reminder/acknowledge",
      );
    }

    const response = await fetch(
      `${getLocalServiceBaseUrl()}/reminder/acknowledge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw new Error("提醒确认失败。");
    }

    return unwrapContract<ReminderAcknowledgeResponse>(
      await response.json(),
      reminderAcknowledgeResultSchema,
      "reminder/acknowledge",
    );
  },
};

export type { LocalServiceBootstrap };
