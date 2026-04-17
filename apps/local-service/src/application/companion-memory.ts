import { createPrefixedId, nowIso } from "@zhuochong/shared";
import type {
  CompanionEventRecordRequest,
  CompanionProfileSummaryDto,
  ExplicitMemoryRememberRequest,
} from "@zhuochong/ui-contracts";

import type { ConversationMessage, DiaryEntry, MemoryRecord } from "../domain/models.js";
import type { LocalServiceRuntime } from "./runtime.js";

const toDateKey = (iso: string) => iso.slice(0, 10);
const tendencyHalfLifeMs = 10 * 24 * 60 * 60_000;

type RecordedCompanionEvent = {
  memories: MemoryRecord[];
  diary: DiaryEntry;
};

type TendencyPayload = {
  version: 1;
  score: number;
  lifetimeCount: number;
  updatedAt: string;
};

const createDerivedMemory = (params: {
  category: MemoryRecord["category"];
  key: string;
  valueText: string;
  confidence: number;
  observedAt: string;
}): MemoryRecord => ({
  memoryId: createPrefixedId("memory"),
  category: params.category,
  key: params.key,
  valueText: params.valueText,
  confidence: params.confidence,
  source: "derived",
  firstObservedAt: params.observedAt,
  lastConfirmedAt: params.observedAt,
  status: "active",
});

const roundScore = (value: number) =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;

const applyDecay = (score: number, lastUpdatedAt: string, now: string) => {
  const lastMs = Date.parse(lastUpdatedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs) || nowMs <= lastMs) {
    return roundScore(score);
  }

  const elapsed = nowMs - lastMs;
  const decayed = score * Math.pow(0.5, elapsed / tendencyHalfLifeMs);
  return roundScore(decayed);
};

const parseLegacyCount = (valueText: string) => {
  const matched = valueText.match(/\d+/);
  return matched ? Number(matched[0]) : 0;
};

const parseTendencyPayload = (
  record: MemoryRecord | null,
): TendencyPayload => {
  if (!record) {
    return {
      version: 1,
      score: 0,
      lifetimeCount: 0,
      updatedAt: nowIso(),
    };
  }

  try {
    const parsed = JSON.parse(record.valueText) as Partial<TendencyPayload>;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.score === "number" &&
      typeof parsed.lifetimeCount === "number" &&
      typeof parsed.updatedAt === "string"
    ) {
      return {
        version: 1,
        score: parsed.score,
        lifetimeCount: parsed.lifetimeCount,
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    // Fall through to legacy parse.
  }

  const legacyCount = parseLegacyCount(record.valueText);
  return {
    version: 1,
    score: legacyCount,
    lifetimeCount: legacyCount,
    updatedAt: record.lastConfirmedAt,
  };
};

const encodeTendencyPayload = (payload: TendencyPayload) => JSON.stringify(payload);

const compactMemoryClue = (value: string) => {
  const [head] = value.split(/[：:]/);
  return (head || value).trim();
};

const joinSummaryParts = (parts: Array<string | null | undefined>) =>
  parts.filter((part): part is string => Boolean(part && part.trim())).join("");

const inferExplicitMemoryCategory = (
  text: string,
): MemoryRecord["category"] =>
  /(喜欢|偏好|习惯|希望|不要|想要|常用|一般会)/.test(text)
    ? "preference"
    : "profile";

const createExplicitMemoryKey = (text: string) =>
  text
    .replace(/^[：:，,\s]+/, "")
    .replace(/[。！!？?]+$/, "")
    .trim()
    .slice(0, 16) || "显式记忆";

const cleanSentence = (text: string) =>
  text
    .replace(/^[\s，,。！？!?：:；;]+/, "")
    .replace(/[\s，,。！？!?：:；;]+$/g, "")
    .trim();

const clauseSplitPattern = /(?:，|,|、|；|;|\s+(?:也|还|并且|而且|同时)\s+)/;

const splitSentenceClauses = (text: string) =>
  text
    .split(clauseSplitPattern)
    .map((clause) => cleanSentence(clause))
    .filter(Boolean);

const normalizeMemoryValue = (text: string) =>
  cleanSentence(
    text
      .replace(/^(其实|就是|可能|感觉|觉得|然后|最近|目前|现在|平时)\s*/, "")
      .replace(/^(我)(?:自己)?/, ""),
  );

const normalizeMemoryTopic = (text: string) =>
  cleanSentence(
    normalizeMemoryValue(text)
      .replace(/^(很|最|比较|特别|有点|会|总是|经常|常常|一般|通常)/, "")
      .replace(/^(在做|正在做|做|用|想要|希望|喜欢|讨厌|不喜欢|习惯)/, "")
      .replace(/^(一个|一种|一些)/, ""),
  ).slice(0, 24);

const createSemanticMemoryKey = (
  prefix: string,
  text: string,
  fallback: string,
) => {
  const topic = normalizeMemoryTopic(text);
  return `${prefix}/${topic || fallback}`;
};

const splitChatSentences = (text: string) =>
  text
    .split(/[。！？!?\n]+/)
    .map((sentence) => cleanSentence(sentence))
    .filter(Boolean);

const buildConversationMemory = (params: {
  category: MemoryRecord["category"];
  key: string;
  valueText: string;
  observedAt: string;
  sourceMessageId: string;
  confidence: number;
}): MemoryRecord => ({
  memoryId: createPrefixedId("memory"),
  category: params.category,
  key: params.key,
  valueText: params.valueText,
  confidence: params.confidence,
  source: "conversation",
  sourceMessageId: params.sourceMessageId,
  firstObservedAt: params.observedAt,
  lastConfirmedAt: params.observedAt,
  status: "active",
});

const inferConversationMemoryCandidates = (
  message: ConversationMessage,
): MemoryRecord[] => {
  const observedAt = message.createdAt;
  const candidates: MemoryRecord[] = [];

  for (const sentence of splitChatSentences(message.text)) {
    for (const clause of splitSentenceClauses(sentence)) {
      const normalized = normalizeMemoryValue(clause);
      if (!normalized) {
        continue;
      }

      let category: MemoryRecord["category"] | null = null;
      let key = "";
      let confidence = 0.72;

      if (/我(很)?喜欢|我(最)?爱/.test(clause)) {
        category = "preference";
        key = createSemanticMemoryKey("偏好", clause, "喜欢的事");
        confidence = 0.86;
      } else if (/我不喜欢|我讨厌|我不想/.test(clause)) {
        category = "preference";
        key = createSemanticMemoryKey("避开", clause, "不喜欢的事");
        confidence = 0.86;
      } else if (/我想要|我希望|希望你|最好|别\s*/.test(clause)) {
        category = "preference";
        key = createSemanticMemoryKey("期待", clause, "期待偏好");
        confidence = 0.78;
      } else if (/我一般|我通常|我经常|我每天|我老是|我习惯/.test(clause)) {
        category = "habit";
        key = createSemanticMemoryKey("习惯", clause, "日常习惯");
        confidence = 0.8;
      } else if (/我是|我在.+(?:工作|上班|上学)|我是个|我做.+开发|我最近在做/.test(clause)) {
        category = "profile";
        key = /我最近在做/.test(clause)
          ? createSemanticMemoryKey("近况", clause, "最近在做的事")
          : createSemanticMemoryKey("档案", clause, "个人概况");
        confidence = 0.74;
      }

      if (!category) {
        continue;
      }

      const valueText = normalized.slice(0, 80);
      if (!valueText) {
        continue;
      }

      candidates.push(
        buildConversationMemory({
          category,
          key,
          valueText,
          observedAt,
          sourceMessageId: message.messageId,
          confidence,
        }),
      );
    }
  }

  const deduped = new Map<string, MemoryRecord>();
  for (const candidate of candidates) {
    deduped.set(`${candidate.category}:${candidate.key}:${candidate.valueText}`, candidate);
  }

  return [...deduped.values()];
};

export const rememberConversationMemories = async (
  runtime: LocalServiceRuntime,
  message: ConversationMessage,
): Promise<MemoryRecord[]> => {
  if (message.role !== "user" || message.source !== "chat") {
    return [];
  }

  const candidates = inferConversationMemoryCandidates(message);
  if (candidates.length === 0) {
    return [];
  }

  const remembered: MemoryRecord[] = [];
  for (const candidate of candidates) {
    remembered.push(await runtime.repositories.memoryRepository.upsert(candidate));
  }

  return remembered;
};

export const rememberExplicitMemory = async (
  runtime: LocalServiceRuntime,
  request: ExplicitMemoryRememberRequest,
): Promise<MemoryRecord> => {
  const observedAt = nowIso();
  const valueText = String(request.text).trim();
  const category: MemoryRecord["category"] =
    request.category ?? inferExplicitMemoryCategory(valueText);

  return runtime.repositories.memoryRepository.upsert(
    createDerivedMemory({
      category,
      key: createSemanticMemoryKey(
        category === "preference" ? "显式偏好" : "显式档案",
        valueText,
        createExplicitMemoryKey(valueText),
      ),
      valueText,
      confidence: 0.96,
      observedAt,
    }),
  );
};

const fixedCanonicalMemoryKeys = new Set([
  "最近照料",
  "最近随机事件",
  "最近聊天",
  "当前关系阶段",
  "最近关系变化",
  "关系气质",
  "累计投喂次数",
  "累计玩耍次数",
  "累计休息照料次数",
  "累计正向聊天次数",
  "累计负向聊天次数",
  "累计正向事件次数",
  "累计波动事件次数",
  "最近偏好",
  "近期状态倾向",
  "交流印象",
]);

export const isFixedCanonicalMemoryKey = (key: string) =>
  fixedCanonicalMemoryKeys.has(key);

const getProfileToneLead = (petName: string, stage: string) => {
  if (stage === "亲密无间") {
    return `${petName} 已经把你划进最熟悉的领地里，很多小反应都会优先朝你这边偏。`;
  }

  if (stage === "关系很好") {
    return `${petName} 对你已经明显放松下来，遇到顺手的事也更愿意主动靠近。`;
  }

  if (stage === "逐渐熟悉") {
    return `${petName} 正在慢慢摸清你的节奏，偶尔会主动把注意力放到你身上。`;
  }

  if (stage === "刚建立联系") {
    return `${petName} 还在试着确认你的照料方式，但已经愿意留下第一批陪伴记录。`;
  }

  return `${petName} 还在观察你，很多反应都偏谨慎，图鉴信息也会长得比较慢。`;
};

const getTendencyBand = (score: number) => {
  if (score >= 3.5) {
    return "strong" as const;
  }

  if (score >= 1.5) {
    return "medium" as const;
  }

  return "light" as const;
};

const getPreferenceText = (params: {
  feedScore: number;
  playScore: number;
  restScore: number;
}) => {
  const band = getTendencyBand(Math.max(params.feedScore, params.playScore, params.restScore));

  if (params.feedScore > params.playScore && params.feedScore > params.restScore) {
    return band === "strong"
      ? "现在明显更依赖安稳照料和投喂反馈。"
      : band === "medium"
        ? "最近有点偏向安稳照料和投喂反馈。"
        : "目前对安稳照料会有一点偏好。";
  }

  if (params.playScore > params.feedScore && params.playScore > params.restScore) {
    return band === "strong"
      ? "现在明显更偏爱互动玩耍带来的回应。"
      : band === "medium"
        ? "最近有点偏向互动玩耍带来的回应。"
        : "目前对互动玩耍会有一点偏好。";
  }

  return band === "strong"
    ? "现在明显更需要稳定、不过载的陪伴节奏。"
    : band === "medium"
      ? "最近有点偏向稳定、不过载的陪伴节奏。"
      : "目前更适合轻一点、稳一点的陪伴节奏。";
};

const getEventTendencyText = (positiveEventScore: number, negativeEventScore: number) => {
  const band = getTendencyBand(Math.max(positiveEventScore, negativeEventScore));

  if (negativeEventScore > positiveEventScore) {
    return band === "strong"
      ? "最近明显更容易受环境波动影响，状态偏敏感。"
      : band === "medium"
        ? "最近有些容易受环境波动影响。"
        : "最近偶尔会出现一点状态波动。";
  }

  return band === "strong"
    ? "最近整体状态很稳，正反馈积累得更顺。"
    : band === "medium"
      ? "最近整体状态还算稳定，能慢慢积累正反馈。"
      : "最近状态基本平稳。";
};

const getChatImpressionText = (positiveChatScore: number, negativeChatScore: number) => {
  const band = getTendencyBand(Math.max(positiveChatScore, negativeChatScore));

  if (positiveChatScore > negativeChatScore) {
    return band === "strong"
      ? "现在对温和、关心式聊天会明显给出更好的反馈。"
      : band === "medium"
        ? "最近对温和、关心式聊天更容易给出正反馈。"
        : "目前对温和聊天会有一点更好的回应。";
  }

  if (negativeChatScore > positiveChatScore) {
    return band === "strong"
      ? "现在对生硬或不耐烦的聊天会明显更敏感。"
      : band === "medium"
        ? "最近对生硬或不耐烦的聊天更敏感。"
        : "目前对生硬聊天会有一点戒备。";
  }

  return "目前对聊天的反馈还在慢慢形成稳定倾向。";
};

const getRecentInteractionMemory = (
  request: CompanionEventRecordRequest,
  occurredAt: string,
): MemoryRecord | null => {
  if (request.type === "care_action") {
    return createDerivedMemory({
      category: "habit",
      key: "最近照料",
      valueText: `${request.title}：${request.description}`,
      confidence: 0.84,
      observedAt: occurredAt,
    });
  }

  if (request.type === "random_event") {
    return createDerivedMemory({
      category: "event",
      key: "最近随机事件",
      valueText: `${request.title}：${request.description}`,
      confidence: 0.82,
      observedAt: occurredAt,
    });
  }

  return createDerivedMemory({
    category: "relationship",
    key: "最近聊天",
    valueText: `${request.title}：${request.description}`,
    confidence: 0.8,
    observedAt: occurredAt,
  });
};

const getRelationStageMemory = (
  relationStage: string,
  occurredAt: string,
): MemoryRecord =>
  createDerivedMemory({
    category: "relationship",
    key: "当前关系阶段",
    valueText: relationStage,
    confidence: 0.93,
    observedAt: occurredAt,
  });

const getRelationChangeMemory = (
  request: CompanionEventRecordRequest,
  occurredAt: string,
): MemoryRecord | null => {
  const delta = request.affinityDelta ?? 0;
  if (delta === 0) {
    return null;
  }

  return createDerivedMemory({
    category: "relationship",
    key: "最近关系变化",
    valueText:
      delta > 0
        ? `${request.title}让你们更亲近了一点。`
        : `${request.title}让关系出现了一点波动。`,
    confidence: 0.9,
    observedAt: occurredAt,
  });
};

const getProfileMemories = (
  request: CompanionEventRecordRequest,
  occurredAt: string,
): MemoryRecord[] => [
  createDerivedMemory({
    category: "profile",
    key: "关系气质",
    valueText:
      request.relationStage === "亲密无间"
        ? "已经进入高度亲近、明显偏爱你的状态。"
        : request.relationStage === "关系很好"
          ? "对你已经很放松，愿意主动靠近。"
          : request.relationStage === "逐渐熟悉"
            ? "正在持续熟悉你的节奏。"
            : request.relationStage === "刚建立联系"
              ? "刚建立起稳定联系，还在观察互动方式。"
              : "目前仍偏谨慎，需要继续建立信任。",
    confidence: 0.88,
    observedAt: occurredAt,
  }),
];

const parseHighlights = (entry: DiaryEntry | null): string[] => {
  if (!entry) {
    return [];
  }

  try {
    const parsed = JSON.parse(entry.highlightsJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const createDiaryLead = (request: CompanionEventRecordRequest) => {
  if (request.type === "care_action") {
    return `今天你又照料了它一次：${request.title}。`;
  }

  if (request.type === "random_event") {
    return `今天发生了一次小插曲：${request.title}。`;
  }

  const delta = request.affinityDelta ?? 0;
  if (delta > 0) {
    return "今天的聊天让它更愿意靠近你。";
  }

  if (delta < 0) {
    return "今天的聊天里也有一点小波动。";
  }

  return "今天你又和它聊了聊。";
};

const buildDiaryText = (params: {
  request: CompanionEventRecordRequest;
  relationStage: string;
  highlights: string[];
}) => {
  const lead = createDiaryLead(params.request);
  const highlightText = params.highlights.length
    ? `它记下了：${params.highlights.join("、")}。`
    : "";

  return [
    lead,
    highlightText,
    `现在的关系阶段是「${params.relationStage}」。`,
  ]
    .filter(Boolean)
    .join("");
};

const accumulateTendency = async (params: {
  runtime: LocalServiceRuntime;
  key: string;
  delta: number;
  occurredAt: string;
}): Promise<TendencyPayload> => {
  const existing = await params.runtime.repositories.memoryRepository.findActiveByKey({
    category: "profile",
    key: params.key,
  });
  const parsed = parseTendencyPayload(existing);
  const decayedScore = applyDecay(parsed.score, parsed.updatedAt, params.occurredAt);

  return {
    version: 1,
    score: roundScore(decayedScore + params.delta),
    lifetimeCount: parsed.lifetimeCount + (params.delta > 0 ? 1 : 0),
    updatedAt: params.occurredAt,
  };
};

const getAccumulatedProfileMemories = async (
  runtime: LocalServiceRuntime,
  request: CompanionEventRecordRequest,
  occurredAt: string,
): Promise<MemoryRecord[]> => {
  const deltas = {
    feed: 0,
    play: 0,
    rest: 0,
    positiveChat: 0,
    negativeChat: 0,
    positiveEvent: 0,
    negativeEvent: 0,
  };

  if (request.type === "care_action") {
    if (request.title.includes("喂食")) {
      deltas.feed = 1;
    } else if (request.title.includes("玩耍")) {
      deltas.play = 1;
    } else {
      deltas.rest = 1;
    }
  }

  if (request.type === "chat_affinity") {
    if ((request.affinityDelta ?? 0) > 0) {
      deltas.positiveChat = 1;
    } else if ((request.affinityDelta ?? 0) < 0) {
      deltas.negativeChat = 1;
    }
  }

  if (request.type === "random_event") {
    if ((request.affinityDelta ?? 0) > 0) {
      deltas.positiveEvent = 1;
    } else if ((request.affinityDelta ?? 0) < 0) {
      deltas.negativeEvent = 1;
    }
  }

  const [
    feed,
    play,
    rest,
    positiveChat,
    negativeChat,
    positiveEvent,
    negativeEvent,
  ] = await Promise.all([
    accumulateTendency({ runtime, key: "累计投喂次数", delta: deltas.feed, occurredAt }),
    accumulateTendency({ runtime, key: "累计玩耍次数", delta: deltas.play, occurredAt }),
    accumulateTendency({ runtime, key: "累计休息照料次数", delta: deltas.rest, occurredAt }),
    accumulateTendency({ runtime, key: "累计正向聊天次数", delta: deltas.positiveChat, occurredAt }),
    accumulateTendency({ runtime, key: "累计负向聊天次数", delta: deltas.negativeChat, occurredAt }),
    accumulateTendency({ runtime, key: "累计正向事件次数", delta: deltas.positiveEvent, occurredAt }),
    accumulateTendency({ runtime, key: "累计波动事件次数", delta: deltas.negativeEvent, occurredAt }),
  ]);

  const tendencyRecords = [
    ["累计投喂次数", feed],
    ["累计玩耍次数", play],
    ["累计休息照料次数", rest],
    ["累计正向聊天次数", positiveChat],
    ["累计负向聊天次数", negativeChat],
    ["累计正向事件次数", positiveEvent],
    ["累计波动事件次数", negativeEvent],
  ] as const;

  return [
    ...tendencyRecords.map(([key, payload]) =>
      createDerivedMemory({
        category: "profile",
        key,
        valueText: encodeTendencyPayload(payload),
        confidence: 0.86,
        observedAt: occurredAt,
      }),
    ),
    createDerivedMemory({
      category: "profile",
      key: "最近偏好",
      valueText: getPreferenceText({
        feedScore: feed.score,
        playScore: play.score,
        restScore: rest.score,
      }),
      confidence: 0.84,
      observedAt: occurredAt,
    }),
    createDerivedMemory({
      category: "profile",
      key: "近期状态倾向",
      valueText: getEventTendencyText(positiveEvent.score, negativeEvent.score),
      confidence: 0.8,
      observedAt: occurredAt,
    }),
    createDerivedMemory({
      category: "profile",
      key: "交流印象",
      valueText: getChatImpressionText(positiveChat.score, negativeChat.score),
      confidence: 0.84,
      observedAt: occurredAt,
    }),
  ];
};

export const recordCompanionEvent = async (
  runtime: LocalServiceRuntime,
  request: CompanionEventRecordRequest,
): Promise<RecordedCompanionEvent> => {
  const occurredAt = request.occurredAt ?? nowIso();
  const touchedMemories: MemoryRecord[] = [];
  const candidateMemories = [
    getRecentInteractionMemory(request, occurredAt),
    getRelationStageMemory(request.relationStage, occurredAt),
    getRelationChangeMemory(request, occurredAt),
    ...getProfileMemories(request, occurredAt),
    ...(await getAccumulatedProfileMemories(runtime, request, occurredAt)),
  ].filter((memory): memory is MemoryRecord => memory !== null);

  for (const memory of candidateMemories) {
    touchedMemories.push(await runtime.repositories.memoryRepository.upsert(memory));
  }

  const date = toDateKey(occurredAt);
  const existingDiary = await runtime.repositories.diaryRepository.getByDate(date);
  const existingHighlights = parseHighlights(existingDiary);
  const latestHighlight = request.title.trim();
  const highlights = Array.from(
    new Set([...existingHighlights, latestHighlight].filter(Boolean)),
  ).slice(-4);
  const memoryCount = (await runtime.repositories.memoryRepository.listByDate(date)).length;
  const diary = await runtime.repositories.diaryRepository.upsert({
    diaryId: existingDiary?.diaryId ?? createPrefixedId("diary"),
    date,
    diaryText: buildDiaryText({
      request,
      relationStage: request.relationStage,
      highlights,
    }),
    highlightsJson: JSON.stringify(highlights),
    memoryCount,
    generatedAt: nowIso(),
  });

  return {
    memories: touchedMemories,
    diary,
  };
};

export const buildChatMemoryContext = async (
  runtime: LocalServiceRuntime,
): Promise<string> => {
  const [summary, memories] = await Promise.all([
    buildCompanionProfileSummary(runtime),
    runtime.repositories.memoryRepository.listRelevantForChat({
      limit: 8,
      categories: ["preference", "habit", "profile", "relationship"],
    }),
  ]);

  const memoryLines = memories
    .filter((memory) => memory.status === "active")
    .slice(0, 6)
    .map((memory) => `- ${memory.key}：${memory.valueText}`);

  const dedupedHighlights = summary.highlights.filter(
    (highlight, index, array) =>
      array.indexOf(highlight) === index &&
      !memoryLines.some((line) => line.includes(highlight)),
  );

  const parts = [
    `以下是你已经记住的用户与陪伴背景，请自然使用，不要逐条复述，也不要假装这些信息是刚刚才知道的。`,
    `关系阶段：${summary.relationStage}`,
    `个体摘要：${summary.summaryText}`,
    dedupedHighlights.length > 0
      ? `记忆提示：${dedupedHighlights.join("；")}`
      : null,
    memoryLines.length > 0
      ? `可参考的长期记忆：\n${memoryLines.join("\n")}`
      : null,
  ];

  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n");
};

export const buildCompanionProfileSummary = async (
  runtime: LocalServiceRuntime,
): Promise<CompanionProfileSummaryDto> => {
  const settings = await runtime.repositories.settingsRepository.get();
  const memories = await runtime.repositories.memoryRepository.listRelevantForChat({
    limit: 50,
  });
  const diaries = await runtime.repositories.diaryRepository.listRecent(7);
  const petName = settings.pet.displayName;
  const getLatestMemoryByKey = (key: string) =>
    memories.find((memory) => memory.key === key) ?? null;

  const currentStageMemory = getLatestMemoryByKey("当前关系阶段");
  const relationChangeMemory = getLatestMemoryByKey("最近关系变化");
  const careMemory = getLatestMemoryByKey("最近照料");
  const eventMemory = getLatestMemoryByKey("最近随机事件");
  const chatMemory = getLatestMemoryByKey("最近聊天");
  const temperamentMemory = getLatestMemoryByKey("关系气质");
  const feedPayload = parseTendencyPayload(getLatestMemoryByKey("累计投喂次数"));
  const playPayload = parseTendencyPayload(getLatestMemoryByKey("累计玩耍次数"));
  const restPayload = parseTendencyPayload(getLatestMemoryByKey("累计休息照料次数"));
  const positiveChatPayload = parseTendencyPayload(getLatestMemoryByKey("累计正向聊天次数"));
  const negativeChatPayload = parseTendencyPayload(getLatestMemoryByKey("累计负向聊天次数"));
  const positiveEventPayload = parseTendencyPayload(getLatestMemoryByKey("累计正向事件次数"));
  const negativeEventPayload = parseTendencyPayload(getLatestMemoryByKey("累计波动事件次数"));
  const now = nowIso();

  const feedScore = applyDecay(feedPayload.score, feedPayload.updatedAt, now);
  const playScore = applyDecay(playPayload.score, playPayload.updatedAt, now);
  const restScore = applyDecay(restPayload.score, restPayload.updatedAt, now);
  const positiveChatScore = applyDecay(
    positiveChatPayload.score,
    positiveChatPayload.updatedAt,
    now,
  );
  const negativeChatScore = applyDecay(
    negativeChatPayload.score,
    negativeChatPayload.updatedAt,
    now,
  );
  const positiveEventScore = applyDecay(
    positiveEventPayload.score,
    positiveEventPayload.updatedAt,
    now,
  );
  const negativeEventScore = applyDecay(
    negativeEventPayload.score,
    negativeEventPayload.updatedAt,
    now,
  );

  const preferenceText = getPreferenceText({
    feedScore,
    playScore,
    restScore,
  });
  const tendencyText = getEventTendencyText(positiveEventScore, negativeEventScore);
  const impressionText = getChatImpressionText(positiveChatScore, negativeChatScore);

  const latestDiary = diaries[0] ?? null;
  const relationStage = currentStageMemory?.valueText ?? "刚建立联系";
  const latestDiaryHighlights = parseHighlights(latestDiary);

  const summaryText =
    !latestDiary && memories.length === 0
      ? joinSummaryParts([
          getProfileToneLead(petName, relationStage),
          `现在还没攒出足够的陪伴记录，等 ${petName} 再多记住你一点，这里会慢慢长成真的图鉴说明。`,
        ])
      : joinSummaryParts([
          getProfileToneLead(petName, relationStage),
          temperamentMemory?.valueText,
          preferenceText,
          tendencyText,
          impressionText,
          latestDiary?.diaryText,
          latestDiary ? null : `它目前把你们的关系记作「${relationStage}」。`,
          relationChangeMemory
            ? `最近一次关系变化是：${relationChangeMemory.valueText}`
            : null,
          careMemory ? `它也记得你最近的照料：${careMemory.valueText}` : null,
          !careMemory && eventMemory
            ? `最近留下的事件印象是：${eventMemory.valueText}`
            : null,
          !careMemory && !eventMemory && chatMemory
            ? `它最近记住的一段聊天是：${chatMemory.valueText}`
            : null,
        ]);

  const highlights = [
    ...latestDiaryHighlights.slice(0, 2),
    compactMemoryClue(preferenceText),
    compactMemoryClue(tendencyText),
    compactMemoryClue(impressionText),
    relationChangeMemory ? compactMemoryClue(relationChangeMemory.valueText) : null,
    careMemory ? compactMemoryClue(careMemory.valueText) : null,
    eventMemory ? compactMemoryClue(eventMemory.valueText) : null,
    !eventMemory && chatMemory ? compactMemoryClue(chatMemory.valueText) : null,
  ]
    .filter(
      (value, index, array): value is string =>
        Boolean(value) && array.indexOf(value) === index,
    )
    .slice(0, 4);

  return {
    petName,
    relationStage,
    summaryText,
    highlights,
    generatedAt: now,
  };
};
