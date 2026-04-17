import type { ChatSessionStatsDto } from "@zhuochong/ui-contracts";
import { createPrefixedId, nowIso, toDateKey } from "@zhuochong/shared";

import { isFixedCanonicalMemoryKey } from "../application/companion-memory.js";
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

const normalizeMemoryText = (value: string) =>
  value.replace(/[\s，,。！？!?：:；;]+/g, "").trim();

const isSameMemoryValue = (left: string, right: string) =>
  normalizeMemoryText(left) === normalizeMemoryText(right);

const mergeConfirmedMemory = (
  existingRecord: MemoryRecord,
  incomingRecord: MemoryRecord,
): MemoryRecord => ({
  ...incomingRecord,
  memoryId: existingRecord.memoryId,
  firstObservedAt: existingRecord.firstObservedAt,
  sourceMessageId: incomingRecord.sourceMessageId ?? existingRecord.sourceMessageId,
  confidence: Math.max(existingRecord.confidence, incomingRecord.confidence),
  lastConfirmedAt:
    existingRecord.lastConfirmedAt.localeCompare(incomingRecord.lastConfirmedAt) > 0
      ? existingRecord.lastConfirmedAt
      : incomingRecord.lastConfirmedAt,
});

const maxMessages = 2_000;
const maxSessions = 50;
const maxMemoryRecords = 500;
const maxPetStateSnapshots = 200;
const maxReminderRecords = 200;

const trimArrayToSize = <T>(array: T[], maxSize: number): T[] =>
  array.length > maxSize ? array.slice(-maxSize) : array;

const sortByNewest = <T extends { createdAt?: string; triggeredAt?: string; generatedAt?: string }>(
  records: T[],
): T[] =>
  [...records].sort((left, right) => {
    const leftValue = left.createdAt ?? left.triggeredAt ?? left.generatedAt ?? "";
    const rightValue = right.createdAt ?? right.triggeredAt ?? right.generatedAt ?? "";
    return rightValue.localeCompare(leftValue);
  });

export class InMemoryConversationRepository implements ConversationRepository {
  private activeSessionId: string | null = null;

  private readonly sessions = new Map<string, ConversationSession>();

  private readonly messages: ConversationMessage[] = [];

  private createSession(status: ConversationSession["status"]): ConversationSession {
    const timestamp = nowIso();
    return {
      sessionId: createPrefixedId("session"),
      status,
      startedAt: timestamp,
      lastMessageAt: timestamp,
    };
  }

  async getOrCreateActiveSession(): Promise<ConversationSession> {
    if (this.activeSessionId) {
      const activeSession = this.sessions.get(this.activeSessionId);
      if (activeSession) {
        return activeSession;
      }
    }

    const session = this.createSession("active");
    this.sessions.set(session.sessionId, session);
    this.activeSessionId = session.sessionId;

    return session;
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    this.messages.push(message);
    if (this.messages.length > maxMessages) {
      this.messages.splice(0, this.messages.length - maxMessages);
    }
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.set(sessionId, {
      ...session,
      lastMessageAt,
    });
  }

  async createNewSession(): Promise<ConversationSession> {
    if (this.activeSessionId) {
      const previousActiveSession = this.sessions.get(this.activeSessionId);
      if (previousActiveSession) {
        this.sessions.set(this.activeSessionId, {
          ...previousActiveSession,
          status: "archived",
        });
      }
    }

    const session = this.createSession("active");
    this.sessions.set(session.sessionId, session);
    this.activeSessionId = session.sessionId;

    if (this.sessions.size > maxSessions) {
      const archivedEntries = [...this.sessions.entries()]
        .filter(([, s]) => s.status === "archived")
        .sort(([, a], [, b]) => a.lastMessageAt.localeCompare(b.lastMessageAt));
      for (const [id] of archivedEntries) {
        if (this.sessions.size <= maxSessions) break;
        if (id !== this.activeSessionId) {
          this.sessions.delete(id);
        }
      }
    }

    return session;
  }

  async setActiveSession(sessionId: string): Promise<ConversationSession | null> {
    const targetSession = this.sessions.get(sessionId);
    if (!targetSession) {
      return null;
    }

    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      const previousActiveSession = this.sessions.get(this.activeSessionId);
      if (previousActiveSession) {
        this.sessions.set(this.activeSessionId, {
          ...previousActiveSession,
          status: "archived",
        });
      }
    }

    const nextSession: ConversationSession = {
      ...targetSession,
      status: "active",
    };
    this.sessions.set(sessionId, nextSession);
    this.activeSessionId = sessionId;
    return nextSession;
  }

  async listSessions(params: { limit: number }): Promise<ConversationSession[]> {
    return [...this.sessions.values()]
      .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
      .slice(0, params.limit);
  }

  async archiveSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.set(sessionId, {
      ...session,
      status: "archived",
    });

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
  }

  async getSessionStats(sessionId: string): Promise<ChatSessionStatsDto> {
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

      if (isFixedCanonicalMemoryKey(record.key)) {
        this.records[activeMatchIndex] = {
          ...record,
          memoryId: existingRecord.memoryId,
          firstObservedAt: existingRecord.firstObservedAt,
        };
        return this.records[activeMatchIndex]!;
      }

      if (isSameMemoryValue(existingRecord.valueText, record.valueText)) {
        const mergedRecord = mergeConfirmedMemory(existingRecord, record);
        this.records[activeMatchIndex] = mergedRecord;
        return mergedRecord;
      }

      this.records[activeMatchIndex] = {
        ...existingRecord,
        status: "superseded",
      };
      this.records.push(record);
      this.compactMemoryRecords();
      return record;
    }

    this.records.push(record);
    this.compactMemoryRecords();
    return record;
  }

  private compactMemoryRecords() {
    if (this.records.length <= maxMemoryRecords) return;
    const superseded = this.records
      .map((r, i) => ({ record: r, index: i }))
      .filter((e) => e.record.status === "superseded")
      .sort((a, b) => a.record.lastConfirmedAt.localeCompare(b.record.lastConfirmedAt));

    for (const { index } of superseded) {
      if (this.records.length <= maxMemoryRecords) break;
      this.records.splice(index, 1);
    }

    if (this.records.length > maxMemoryRecords) {
      this.records.splice(0, this.records.length - maxMemoryRecords);
    }
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
    if (this.snapshots.length > maxPetStateSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - maxPetStateSnapshots);
    }
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
    if (this.records.length > maxReminderRecords) {
      this.records.splice(0, this.records.length - maxReminderRecords);
    }
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
