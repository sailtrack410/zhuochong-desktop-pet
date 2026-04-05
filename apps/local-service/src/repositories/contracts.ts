import type {
  AppSettings,
  ConversationMessage,
  ConversationSession,
  DiaryEntry,
  MemoryCategory,
  MemoryRecord,
  PetStateSnapshotRecord,
  ReminderRecord,
  SettingsPatch,
} from "../domain/models.js";

export interface ConversationRepository {
  getOrCreateActiveSession(): Promise<ConversationSession>;
  createNewSession(): Promise<ConversationSession>;
  listSessions(params: { limit: number }): Promise<ConversationSession[]>;
  archiveSession(sessionId: string): Promise<void>;
  appendMessage(message: ConversationMessage): Promise<void>;
  listMessages(params: {
    sessionId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<ConversationMessage[]>;
  listRecentMessages(params: {
    sessionId: string;
    limit: number;
  }): Promise<ConversationMessage[]>;
  touchSession(sessionId: string, lastMessageAt: string): Promise<void>;
  getSessionStats(sessionId: string): Promise<{ messageCount: number; userTokens: number; assistantTokens: number }>;
}

export interface SettingsRepository {
  get(): Promise<AppSettings>;
  updatePatch(patch: SettingsPatch): Promise<AppSettings>;
  replace(next: AppSettings): Promise<AppSettings>;
}

export interface MemoryRepository {
  upsert(record: MemoryRecord): Promise<MemoryRecord>;
  findActiveByKey(params: {
    category: MemoryCategory;
    key: string;
  }): Promise<MemoryRecord | null>;
  listRelevantForChat(params: {
    limit: number;
    categories?: MemoryCategory[];
  }): Promise<MemoryRecord[]>;
  listByDate(date: string): Promise<MemoryRecord[]>;
}

export interface DiaryRepository {
  getByDate(date: string): Promise<DiaryEntry | null>;
  upsert(entry: DiaryEntry): Promise<DiaryEntry>;
  listRecent(limit: number): Promise<DiaryEntry[]>;
}

export interface PetStateRepository {
  appendSnapshot(snapshot: PetStateSnapshotRecord): Promise<void>;
  getLatest(): Promise<PetStateSnapshotRecord | null>;
  listRecent(limit: number): Promise<PetStateSnapshotRecord[]>;
}

export interface ReminderLogRepository {
  append(record: ReminderRecord): Promise<void>;
  acknowledge(params: {
    reminderId: string;
    status: "dismissed" | "opened_chat";
    acknowledgedAt: string;
  }): Promise<void>;
  update(params: {
    reminderId: string;
    status: ReminderRecord["status"];
    triggeredAt?: string;
    acknowledgedAt?: string | null;
    suppressionReason?: string | null;
  }): Promise<void>;
  listRecent(params: {
    since?: string;
    limit: number;
  }): Promise<ReminderRecord[]>;
  listPendingDue(params: {
    before: string;
    limit: number;
  }): Promise<ReminderRecord[]>;
  listRecentBySource(params: {
    source: ReminderRecord["source"];
    since: string;
  }): Promise<ReminderRecord[]>;
}

export type LocalServiceRepositories = {
  conversationRepository: ConversationRepository;
  settingsRepository: SettingsRepository;
  memoryRepository: MemoryRepository;
  diaryRepository: DiaryRepository;
  petStateRepository: PetStateRepository;
  reminderLogRepository: ReminderLogRepository;
};
