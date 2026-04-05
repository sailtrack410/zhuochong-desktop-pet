import { createPrefixedId, nowIso, toDateKey } from "@zhuochong/shared";

import { defaultSettings } from "../config/default-settings.js";
import type {
  AppSettings,
  ConversationMessage,
  ConversationSession,
  DiaryEntry,
  MemoryRecord,
  PetStateSnapshotRecord,
  ReminderRecord,
  SettingsPatch,
} from "../domain/models.js";
import type {
  ConversationRepository,
  DiaryRepository,
  LocalServiceRepositories,
  MemoryRepository,
  PetStateRepository,
  ReminderLogRepository,
  SettingsRepository,
} from "./contracts.js";

const sortByNewest = <T extends { createdAt?: string; triggeredAt?: string; generatedAt?: string }>(
  records: T[],
): T[] =>
  [...records].sort((left, right) => {
    const leftValue = left.createdAt ?? left.triggeredAt ?? left.generatedAt ?? "";
    const rightValue = right.createdAt ?? right.triggeredAt ?? right.generatedAt ?? "";
    return rightValue.localeCompare(leftValue);
  });

export class InMemoryConversationRepository implements ConversationRepository {
  private activeSession: ConversationSession | null = null;

  private readonly messages: ConversationMessage[] = [];

  async getOrCreateActiveSession(): Promise<ConversationSession> {
    if (this.activeSession) {
      return this.activeSession;
    }

    const timestamp = nowIso();
    this.activeSession = {
      sessionId: createPrefixedId("session"),
      status: "active",
      startedAt: timestamp,
      lastMessageAt: timestamp,
    };

    return this.activeSession;
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    this.messages.push(message);
  }

  async listMessages(params: {
    sessionId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<ConversationMessage[]> {
    const sessionMessages = this.messages.filter(
      (message) => message.sessionId === params.sessionId,
    );

    if (!params.beforeMessageId) {
      return sessionMessages.slice(-params.limit);
    }

    const beforeIndex = sessionMessages.findIndex(
      (message) => message.messageId === params.beforeMessageId,
    );

    if (beforeIndex <= 0) {
      return [];
    }

    return sessionMessages.slice(Math.max(0, beforeIndex - params.limit), beforeIndex);
  }

  async listRecentMessages(params: {
    sessionId: string;
    limit: number;
  }): Promise<ConversationMessage[]> {
    return this.messages
      .filter((message) => message.sessionId === params.sessionId)
      .slice(-params.limit);
  }

  async touchSession(sessionId: string, lastMessageAt: string): Promise<void> {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return;
    }

    this.activeSession = {
      ...this.activeSession,
      lastMessageAt,
    };
  }

  async createNewSession(): Promise<ConversationSession> {
    const timestamp = nowIso();
    this.activeSession = {
      sessionId: createPrefixedId("session"),
      status: "active",
      startedAt: timestamp,
      lastMessageAt: timestamp,
    };
    return this.activeSession;
  }

  async listSessions(params: { limit: number }): Promise<ConversationSession[]> {
    // 内存版本只返回当前活跃会话
    if (!this.activeSession) {
      return [];
    }
    return [this.activeSession];
  }

  async archiveSession(_sessionId: string): Promise<void> {
    // 内存版本不保留历史会话
  }

  async getSessionStats(sessionId: string): Promise<{ messageCount: number; userTokens: number; assistantTokens: number }> {
    const sessionMessages = this.messages.filter(
      (message) => message.sessionId === sessionId,
    );

    let userTokens = 0;
    let assistantTokens = 0;

    for (const msg of sessionMessages) {
      const tokens = Math.ceil(msg.text.length / 2);
      if (msg.role === "user") {
        userTokens += tokens;
      } else if (msg.role === "assistant") {
        assistantTokens += tokens;
      }
    }

    return {
      messageCount: sessionMessages.length,
      userTokens,
      assistantTokens,
    };
  }
}

export class InMemorySettingsRepository implements SettingsRepository {
  private settings: AppSettings = defaultSettings();

  async get(): Promise<AppSettings> {
    return this.settings;
  }

  async updatePatch(patch: SettingsPatch): Promise<AppSettings> {
    const current = this.settings;
    const modelPatch = patch.model;
    const nextModel = {
      ...current.model,
      ...(modelPatch?.baseUrl !== undefined ? { baseUrl: modelPatch.baseUrl } : {}),
      ...(modelPatch?.modelName !== undefined
        ? { modelName: modelPatch.modelName }
        : {}),
    };
    const apiKeyEncrypted = modelPatch?.clearApiKey
      ? undefined
      : modelPatch?.apiKeyInput ?? current.model.apiKeyEncrypted;
    const model =
      apiKeyEncrypted === undefined
        ? nextModel
        : { ...nextModel, apiKeyEncrypted };

    this.settings = {
      ...current,
      model,
      behavior: {
        ...current.behavior,
        ...patch.behavior,
      },
      pet: {
        ...current.pet,
        ...patch.pet,
      },
      capabilities: {
        ...current.capabilities,
        ...patch.capabilities,
      },
      updatedAt: nowIso(),
    };

    return this.settings;
  }

  async replace(next: AppSettings): Promise<AppSettings> {
    this.settings = {
      ...next,
      updatedAt: nowIso(),
    };
    return this.settings;
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly records: MemoryRecord[] = [];

  async upsert(record: MemoryRecord): Promise<MemoryRecord> {
    const existingIndex = this.records.findIndex(
      (candidate) => candidate.memoryId === record.memoryId,
    );

    if (existingIndex >= 0) {
      this.records[existingIndex] = record;
      return record;
    }

    const activeMatchIndex = this.records.findIndex(
      (candidate) =>
        candidate.status === "active" &&
        candidate.category === record.category &&
        candidate.key === record.key,
    );

    if (activeMatchIndex >= 0) {
      const existingRecord = this.records[activeMatchIndex];
      if (!existingRecord) {
        this.records.push(record);
        return record;
      }

      this.records[activeMatchIndex] = {
        ...record,
        memoryId: existingRecord.memoryId,
        firstObservedAt: existingRecord.firstObservedAt,
      };
      return this.records[activeMatchIndex]!;
    }

    this.records.push(record);
    return record;
  }

  async findActiveByKey(params: {
    category: MemoryRecord["category"];
    key: string;
  }): Promise<MemoryRecord | null> {
    return (
      this.records.find(
        (record) =>
          record.status === "active" &&
          record.category === params.category &&
          record.key === params.key,
      ) ?? null
    );
  }

  async listRelevantForChat(params: {
    limit: number;
    categories?: MemoryRecord["category"][];
  }): Promise<MemoryRecord[]> {
    const filtered = this.records.filter(
      (record) =>
        record.status === "active" &&
        (!params.categories || params.categories.includes(record.category)),
    );

    return [...filtered]
      .sort((left, right) => right.lastConfirmedAt.localeCompare(left.lastConfirmedAt))
      .slice(0, params.limit);
  }

  async listByDate(date: string): Promise<MemoryRecord[]> {
    return this.records.filter(
      (record) => toDateKey(record.lastConfirmedAt) === date,
    );
  }
}

export class InMemoryDiaryRepository implements DiaryRepository {
  private readonly entries = new Map<string, DiaryEntry>();

  async getByDate(date: string): Promise<DiaryEntry | null> {
    return this.entries.get(date) ?? null;
  }

  async upsert(entry: DiaryEntry): Promise<DiaryEntry> {
    this.entries.set(entry.date, entry);
    return entry;
  }

  async listRecent(limit: number): Promise<DiaryEntry[]> {
    return sortByNewest([...this.entries.values()]).slice(0, limit);
  }
}

export class InMemoryPetStateRepository implements PetStateRepository {
  private readonly snapshots: PetStateSnapshotRecord[] = [];

  async appendSnapshot(snapshot: PetStateSnapshotRecord): Promise<void> {
    this.snapshots.push(snapshot);
  }

  async getLatest(): Promise<PetStateSnapshotRecord | null> {
    return this.snapshots.at(-1) ?? null;
  }

  async listRecent(limit: number): Promise<PetStateSnapshotRecord[]> {
    return sortByNewest(this.snapshots).slice(0, limit);
  }
}

export class InMemoryReminderLogRepository implements ReminderLogRepository {
  private readonly records: ReminderRecord[] = [];

  async append(record: ReminderRecord): Promise<void> {
    this.records.push(record);
  }

  async acknowledge(params: {
    reminderId: string;
    status: "dismissed" | "opened_chat";
    acknowledgedAt: string;
  }): Promise<void> {
    const target = this.records.find((record) => record.reminderId === params.reminderId);
    if (!target) {
      return;
    }

    target.status = params.status;
    target.acknowledgedAt = params.acknowledgedAt;
  }

  async update(params: {
    reminderId: string;
    status: ReminderRecord["status"];
    triggeredAt?: string;
    acknowledgedAt?: string | null;
    suppressionReason?: string | null;
  }): Promise<void> {
    const target = this.records.find((record) => record.reminderId === params.reminderId);
    if (!target) {
      return;
    }

    target.status = params.status;

    if (params.triggeredAt !== undefined) {
      target.triggeredAt = params.triggeredAt;
    }

    if (params.acknowledgedAt !== undefined) {
      if (params.acknowledgedAt) {
        target.acknowledgedAt = params.acknowledgedAt;
      } else {
        delete target.acknowledgedAt;
      }
    }

    if (params.suppressionReason !== undefined) {
      if (params.suppressionReason) {
        target.suppressionReason = params.suppressionReason;
      } else {
        delete target.suppressionReason;
      }
    }
  }

  async listRecent(params: {
    since?: string;
    limit: number;
  }): Promise<ReminderRecord[]> {
    const filtered = params.since
      ? this.records.filter((record) => record.triggeredAt >= params.since!)
      : this.records;

    return sortByNewest(filtered).slice(0, params.limit);
  }

  async listPendingDue(params: {
    before: string;
    limit: number;
  }): Promise<ReminderRecord[]> {
    return [...this.records]
      .filter(
        (record) =>
          record.status === "pending" &&
          record.source === "manual" &&
          record.triggeredAt <= params.before,
      )
      .sort((left, right) => left.triggeredAt.localeCompare(right.triggeredAt))
      .slice(0, params.limit);
  }

  async listRecentBySource(params: {
    source: ReminderRecord["source"];
    since: string;
  }): Promise<ReminderRecord[]> {
    return this.records.filter(
      (record) =>
        record.source === params.source && record.triggeredAt >= params.since,
    );
  }
}

export const createInMemoryRepositories = (): LocalServiceRepositories => ({
  conversationRepository: new InMemoryConversationRepository(),
  settingsRepository: new InMemorySettingsRepository(),
  memoryRepository: new InMemoryMemoryRepository(),
  diaryRepository: new InMemoryDiaryRepository(),
  petStateRepository: new InMemoryPetStateRepository(),
  reminderLogRepository: new InMemoryReminderLogRepository(),
});
