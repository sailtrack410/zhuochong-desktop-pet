import type { ChatSessionStatsDto } from "@zhuochong/ui-contracts";

import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encryptApiKey } from "../config/api-key-crypto.js";

import { createPrefixedId, nowIso } from "@zhuochong/shared";

import { defaultSettings } from "../config/default-settings.js";
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
import type {
  ConversationRepository,
  DiaryRepository,
  LocalServiceRepositories,
  MemoryRepository,
  PetStateRepository,
  ReminderLogRepository,
  SettingsRepository,
} from "./contracts.js";

type Database = BetterSqlite3.Database;

const LOCAL_SERVICE_SCHEMA_VERSION = 1;

type SqliteConversationSessionRow = {
  sessionId: string;
  status: ConversationSession["status"];
  startedAt: string;
  lastMessageAt: string;
};

type SqliteConversationMessageRow = {
  messageId: string;
  sessionId: string;
  role: ConversationMessage["role"];
  source: ConversationMessage["source"];
  text: string;
  createdAt: string;
  relatedReminderId: string | null;
};

type SqliteMemoryRow = {
  memoryId: string;
  category: MemoryCategory;
  key: string;
  valueText: string;
  confidence: number;
  source: MemoryRecord["source"];
  sourceMessageId: string | null;
  firstObservedAt: string;
  lastConfirmedAt: string;
  status: MemoryRecord["status"];
};

type SqliteDiaryRow = {
  diaryId: string;
  date: string;
  diaryText: string;
  highlightsJson: string;
  memoryCount: number;
  generatedAt: string;
};

type SqlitePetStateRow = {
  snapshotId: string;
  businessState: PetStateSnapshotRecord["businessState"];
  visualState: PetStateSnapshotRecord["visualState"];
  mood: PetStateSnapshotRecord["mood"];
  trigger: PetStateSnapshotRecord["trigger"];
  createdAt: string;
};

type SqliteReminderRow = {
  reminderId: string;
  category: ReminderRecord["category"];
  source: ReminderRecord["source"];
  priority: ReminderRecord["priority"];
  status: ReminderRecord["status"];
  text: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  suppressionReason: string | null;
};

type SqliteSettingsRow = {
  payloadJson: string;
};

const parseJson = <TValue>(value: string): TValue => JSON.parse(value) as TValue;

const mapConversationSession = (
  row: SqliteConversationSessionRow,
): ConversationSession => ({
  sessionId: row.sessionId,
  status: row.status,
  startedAt: row.startedAt,
  lastMessageAt: row.lastMessageAt,
});

const mapConversationMessage = (
  row: SqliteConversationMessageRow,
): ConversationMessage => ({
  messageId: row.messageId,
  sessionId: row.sessionId,
  role: row.role,
  source: row.source,
  text: row.text,
  createdAt: row.createdAt,
  ...(row.relatedReminderId
    ? { relatedReminderId: row.relatedReminderId }
    : {}),
});

const mapMemoryRecord = (row: SqliteMemoryRow): MemoryRecord => ({
  memoryId: row.memoryId,
  category: row.category,
  key: row.key,
  valueText: row.valueText,
  confidence: row.confidence,
  source: row.source,
  firstObservedAt: row.firstObservedAt,
  lastConfirmedAt: row.lastConfirmedAt,
  status: row.status,
  ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
});

const mapDiaryEntry = (row: SqliteDiaryRow): DiaryEntry => ({
  diaryId: row.diaryId,
  date: row.date,
  diaryText: row.diaryText,
  highlightsJson: row.highlightsJson,
  memoryCount: row.memoryCount,
  generatedAt: row.generatedAt,
});

const mapPetStateSnapshot = (
  row: SqlitePetStateRow,
): PetStateSnapshotRecord => ({
  snapshotId: row.snapshotId,
  businessState: row.businessState,
  visualState: row.visualState,
  mood: row.mood,
  trigger: row.trigger,
  createdAt: row.createdAt,
});

const mapReminderRecord = (row: SqliteReminderRow): ReminderRecord => ({
  reminderId: row.reminderId,
  category: row.category,
  source: row.source,
  priority: row.priority,
  status: row.status,
  text: row.text,
  triggeredAt: row.triggeredAt,
  ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {}),
  ...(row.suppressionReason ? { suppressionReason: row.suppressionReason } : {}),
});

const normalizeSettingsPatch = (
  current: AppSettings,
  patch: SettingsPatch,
): AppSettings => {
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
    : modelPatch?.apiKeyInput
      ? encryptApiKey(modelPatch.apiKeyInput)
      : current.model.apiKeyEncrypted;
  const model =
    apiKeyEncrypted === undefined
      ? nextModel
      : { ...nextModel, apiKeyEncrypted };

  return {
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
};

const normalizeStoredSettings = (
  stored: Partial<AppSettings>,
): AppSettings => {
  const defaults = defaultSettings();

  return {
    ...defaults,
    ...stored,
    model: {
      ...defaults.model,
      ...stored.model,
    },
    behavior: {
      ...defaults.behavior,
      ...stored.behavior,
    },
    pet: {
      ...defaults.pet,
      ...stored.pet,
    },
    capabilities: {
      ...defaults.capabilities,
      ...stored.capabilities,
    },
    updatedAt: stored.updatedAt ?? defaults.updatedAt,
  };
};

const ensureSchema = (database: Database): void => {
  const versionRow = database
    .prepare("PRAGMA user_version")
    .get() as { user_version: number } | undefined;
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion > LOCAL_SERVICE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported local-service schema version: ${currentVersion}.`,
    );
  }

  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS app_settings (
      settings_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_single_active
      ON conversation_sessions(status)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS conversation_messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      related_reminder_id TEXT,
      FOREIGN KEY (session_id) REFERENCES conversation_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_created_at
      ON conversation_messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_records (
      memory_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key_text TEXT NOT NULL,
      value_text TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      source_message_id TEXT,
      first_observed_at TEXT NOT NULL,
      last_confirmed_at TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_records_category_key_status
      ON memory_records(category, key_text, status);

    CREATE INDEX IF NOT EXISTS idx_memory_records_last_confirmed_at
      ON memory_records(last_confirmed_at);

    CREATE TABLE IF NOT EXISTS diary_entries (
      diary_id TEXT NOT NULL UNIQUE,
      date TEXT PRIMARY KEY,
      diary_text TEXT NOT NULL,
      highlights_json TEXT NOT NULL,
      memory_count INTEGER NOT NULL,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pet_state_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      business_state TEXT NOT NULL,
      visual_state TEXT NOT NULL,
      mood TEXT NOT NULL,
      trigger TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pet_state_snapshots_created_at
      ON pet_state_snapshots(created_at);

    CREATE TABLE IF NOT EXISTS reminder_records (
      reminder_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      source TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      acknowledged_at TEXT,
      suppression_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reminder_records_source_triggered_at
      ON reminder_records(source, triggered_at);

    CREATE INDEX IF NOT EXISTS idx_reminder_records_status_triggered_at
      ON reminder_records(status, triggered_at);
  `);

  if (currentVersion === 0) {
    database.exec(`PRAGMA user_version = ${LOCAL_SERVICE_SCHEMA_VERSION}`);
  }
};

const createDatabase = (databaseFilePath: string): Database => {
  mkdirSync(dirname(databaseFilePath), { recursive: true });

  const database = new BetterSqlite3(databaseFilePath);
  ensureSchema(database);

  return database;
};

class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: Database) {}

  private getSessionById(sessionId: string): ConversationSession | null {
    const row = this.database
      .prepare(`
        SELECT
          session_id AS sessionId,
          status,
          started_at AS startedAt,
          last_message_at AS lastMessageAt
        FROM conversation_sessions
        WHERE session_id = ?
      `)
      .get(sessionId) as SqliteConversationSessionRow | undefined;

    return row ? mapConversationSession(row) : null;
  }

  async getOrCreateActiveSession(): Promise<ConversationSession> {
    const existing = this.database
      .prepare(`
        SELECT
          session_id AS sessionId,
          status,
          started_at AS startedAt,
          last_message_at AS lastMessageAt
        FROM conversation_sessions
        WHERE status = 'active'
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get() as SqliteConversationSessionRow | undefined;

    if (existing) {
      return mapConversationSession(existing);
    }

    const timestamp = nowIso();
    const session: ConversationSession = {
      sessionId: createPrefixedId("session"),
      status: "active",
      startedAt: timestamp,
      lastMessageAt: timestamp,
    };

    this.database
      .prepare(`
        INSERT INTO conversation_sessions (
          session_id,
          status,
          started_at,
          last_message_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(
        session.sessionId,
        session.status,
        session.startedAt,
        session.lastMessageAt,
      );

    return session;
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO conversation_messages (
          message_id,
          session_id,
          role,
          source,
          text,
          created_at,
          related_reminder_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.messageId,
        message.sessionId,
        message.role,
        message.source,
        message.text,
        message.createdAt,
        message.relatedReminderId ?? null,
      );
  }

  async listMessages(params: {
    sessionId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<ConversationMessage[]> {
    if (!params.beforeMessageId) {
      return this.database
        .prepare(`
          SELECT
            message_id AS messageId,
            session_id AS sessionId,
            role,
            source,
            text,
            created_at AS createdAt,
            related_reminder_id AS relatedReminderId
          FROM conversation_messages
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .all(params.sessionId, params.limit)
        .reverse()
        .map((row) => mapConversationMessage(row as SqliteConversationMessageRow));
    }

    const beforeRow = this.database
      .prepare(`
        SELECT created_at AS createdAt, message_id AS messageId
        FROM conversation_messages
        WHERE session_id = ? AND message_id = ?
        LIMIT 1
      `)
      .get(params.sessionId, params.beforeMessageId) as
      | {
          createdAt: string;
          messageId: string;
        }
      | undefined;

    if (!beforeRow) {
      return [];
    }

    return this.database
      .prepare(`
        SELECT
          message_id AS messageId,
          session_id AS sessionId,
          role,
          source,
          text,
          created_at AS createdAt,
          related_reminder_id AS relatedReminderId
        FROM conversation_messages
        WHERE session_id = ?
          AND (
            created_at < ?
            OR (created_at = ? AND message_id < ?)
          )
        ORDER BY created_at DESC, message_id DESC
        LIMIT ?
      `)
      .all(
        params.sessionId,
        beforeRow.createdAt,
        beforeRow.createdAt,
        beforeRow.messageId,
        params.limit,
      )
      .reverse()
      .map((row) => mapConversationMessage(row as SqliteConversationMessageRow));
  }

  async listRecentMessages(params: {
    sessionId: string;
    limit: number;
  }): Promise<ConversationMessage[]> {
    return this.database
      .prepare(`
        SELECT
          message_id AS messageId,
          session_id AS sessionId,
          role,
          source,
          text,
          created_at AS createdAt,
          related_reminder_id AS relatedReminderId
        FROM conversation_messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(params.sessionId, params.limit)
      .reverse()
      .map((row) => mapConversationMessage(row as SqliteConversationMessageRow));
  }

  async touchSession(sessionId: string, lastMessageAt: string): Promise<void> {
    this.database
      .prepare(`
        UPDATE conversation_sessions
        SET last_message_at = ?
        WHERE session_id = ?
      `)
      .run(lastMessageAt, sessionId);
  }

  async createNewSession(): Promise<ConversationSession> {
    // 将当前活跃会话归档
    this.database
      .prepare(`
        UPDATE conversation_sessions
        SET status = 'archived'
        WHERE status = 'active'
      `)
      .run();

    // 创建新会话
    const timestamp = nowIso();
    const session: ConversationSession = {
      sessionId: createPrefixedId("session"),
      status: "active",
      startedAt: timestamp,
      lastMessageAt: timestamp,
    };

    this.database
      .prepare(`
        INSERT INTO conversation_sessions (
          session_id,
          status,
          started_at,
          last_message_at
        )
        VALUES (?, ?, ?, ?)
      `)
      .run(
        session.sessionId,
        session.status,
        session.startedAt,
        session.lastMessageAt,
      );

    return session;
  }

  async setActiveSession(sessionId: string): Promise<ConversationSession | null> {
    const targetSession = this.getSessionById(sessionId);
    if (!targetSession) {
      return null;
    }

    const switchToSession = this.database.transaction(
      (nextSessionId: string): ConversationSession => {
        this.database
          .prepare(`
            UPDATE conversation_sessions
            SET status = 'archived'
            WHERE status = 'active'
              AND session_id != ?
          `)
          .run(nextSessionId);

        this.database
          .prepare(`
            UPDATE conversation_sessions
            SET status = 'active'
            WHERE session_id = ?
          `)
          .run(nextSessionId);

        const nextSession = this.getSessionById(nextSessionId);
        if (!nextSession) {
          throw new Error("切换活动会话后读取失败。");
        }

        return nextSession;
      },
    );

    return switchToSession(sessionId);
  }

  async listSessions(params: { limit: number }): Promise<ConversationSession[]> {
    const rows = this.database
      .prepare(`
        SELECT
          session_id AS sessionId,
          status,
          started_at AS startedAt,
          last_message_at AS lastMessageAt
        FROM conversation_sessions
        ORDER BY last_message_at DESC
        LIMIT ?
      `)
      .all(params.limit) as SqliteConversationSessionRow[];

    return rows.map(mapConversationSession);
  }

  async archiveSession(sessionId: string): Promise<void> {
    this.database
      .prepare(`
        UPDATE conversation_sessions
        SET status = 'archived'
        WHERE session_id = ?
      `)
      .run(sessionId);
  }

  async getSessionStats(sessionId: string): Promise<ChatSessionStatsDto> {
    const messageCount = this.database
      .prepare(`
        SELECT COUNT(*) as count
        FROM conversation_messages
        WHERE session_id = ?
      `)
      .get(sessionId) as { count: number };

    // 简单估算 token 数量（中文约 1.5 字符/token，英文约 4 字符/token）
    const messages = this.database
      .prepare(`
        SELECT role, text
        FROM conversation_messages
        WHERE session_id = ?
      `)
      .all(sessionId) as { role: string; text: string }[];

    let userTokens = 0;
    let assistantTokens = 0;

    for (const msg of messages) {
      const tokens = Math.ceil(msg.text.length / 2); // 粗略估算
      if (msg.role === "user") {
        userTokens += tokens;
      } else if (msg.role === "assistant") {
        assistantTokens += tokens;
      }
    }

    return {
      messageCount: messageCount.count,
      userTokens,
      assistantTokens,
    };
  }
}

class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly database: Database) {}

  async get(): Promise<AppSettings> {
    const row = this.database
      .prepare(`
        SELECT payload_json AS payloadJson
        FROM app_settings
        WHERE settings_id = 'default'
      `)
      .get() as SqliteSettingsRow | undefined;

    if (!row) {
      const initialSettings = defaultSettings();
      await this.replace(initialSettings);
      return initialSettings;
    }

    return normalizeStoredSettings(parseJson<Partial<AppSettings>>(row.payloadJson));
  }

  async updatePatch(patch: SettingsPatch): Promise<AppSettings> {
    const nextSettings = normalizeSettingsPatch(await this.get(), patch);
    return this.replace(nextSettings);
  }

  async replace(next: AppSettings): Promise<AppSettings> {
    const normalized: AppSettings = {
      ...next,
      updatedAt: nowIso(),
    };

    this.database
      .prepare(`
        INSERT INTO app_settings (
          settings_id,
          payload_json,
          updated_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(settings_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      .run(
        normalized.settingsId,
        JSON.stringify(normalized),
        normalized.updatedAt,
      );

    return normalized;
  }
}

class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly database: Database) {}

  async upsert(record: MemoryRecord): Promise<MemoryRecord> {
    const existingById = this.database
      .prepare(`
        SELECT
          memory_id AS memoryId,
          category,
          key_text AS key,
          value_text AS valueText,
          confidence,
          source,
          source_message_id AS sourceMessageId,
          first_observed_at AS firstObservedAt,
          last_confirmed_at AS lastConfirmedAt,
          status
        FROM memory_records
        WHERE memory_id = ?
        LIMIT 1
      `)
      .get(record.memoryId) as SqliteMemoryRow | undefined;

    if (existingById) {
      this.writeRecord(record);
      return record;
    }

    const activeMatch = this.database
      .prepare(`
        SELECT
          memory_id AS memoryId,
          category,
          key_text AS key,
          value_text AS valueText,
          confidence,
          source,
          source_message_id AS sourceMessageId,
          first_observed_at AS firstObservedAt,
          last_confirmed_at AS lastConfirmedAt,
          status
        FROM memory_records
        WHERE status = 'active' AND category = ? AND key_text = ?
        LIMIT 1
      `)
      .get(record.category, record.key) as SqliteMemoryRow | undefined;

    if (activeMatch) {
      const mergedRecord: MemoryRecord = {
        ...record,
        memoryId: activeMatch.memoryId,
        firstObservedAt: activeMatch.firstObservedAt,
      };
      this.writeRecord(mergedRecord);
      return mergedRecord;
    }

    this.writeRecord(record);
    return record;
  }

  async findActiveByKey(params: {
    category: MemoryCategory;
    key: string;
  }): Promise<MemoryRecord | null> {
    const row = this.database
      .prepare(`
        SELECT
          memory_id AS memoryId,
          category,
          key_text AS key,
          value_text AS valueText,
          confidence,
          source,
          source_message_id AS sourceMessageId,
          first_observed_at AS firstObservedAt,
          last_confirmed_at AS lastConfirmedAt,
          status
        FROM memory_records
        WHERE status = 'active' AND category = ? AND key_text = ?
        LIMIT 1
      `)
      .get(params.category, params.key) as SqliteMemoryRow | undefined;

    return row ? mapMemoryRecord(row) : null;
  }

  async listRelevantForChat(params: {
    limit: number;
    categories?: MemoryCategory[];
  }): Promise<MemoryRecord[]> {
    const rows = params.categories?.length
      ? this.database
          .prepare(`
            SELECT
              memory_id AS memoryId,
              category,
              key_text AS key,
              value_text AS valueText,
              confidence,
              source,
              source_message_id AS sourceMessageId,
              first_observed_at AS firstObservedAt,
              last_confirmed_at AS lastConfirmedAt,
              status
            FROM memory_records
            WHERE status = 'active'
              AND category IN (${params.categories.map(() => "?").join(", ")})
            ORDER BY last_confirmed_at DESC
            LIMIT ?
          `)
          .all(...params.categories, params.limit)
      : this.database
          .prepare(`
            SELECT
              memory_id AS memoryId,
              category,
              key_text AS key,
              value_text AS valueText,
              confidence,
              source,
              source_message_id AS sourceMessageId,
              first_observed_at AS firstObservedAt,
              last_confirmed_at AS lastConfirmedAt,
              status
            FROM memory_records
            WHERE status = 'active'
            ORDER BY last_confirmed_at DESC
            LIMIT ?
          `)
          .all(params.limit);

    return rows.map((row) => mapMemoryRecord(row as SqliteMemoryRow));
  }

  async listByDate(date: string): Promise<MemoryRecord[]> {
    return this.database
      .prepare(`
        SELECT
          memory_id AS memoryId,
          category,
          key_text AS key,
          value_text AS valueText,
          confidence,
          source,
          source_message_id AS sourceMessageId,
          first_observed_at AS firstObservedAt,
          last_confirmed_at AS lastConfirmedAt,
          status
        FROM memory_records
        WHERE substr(last_confirmed_at, 1, 10) = ?
        ORDER BY last_confirmed_at DESC
      `)
      .all(date)
      .map((row) => mapMemoryRecord(row as SqliteMemoryRow));
  }

  private writeRecord(record: MemoryRecord): void {
    this.database
      .prepare(`
        INSERT INTO memory_records (
          memory_id,
          category,
          key_text,
          value_text,
          confidence,
          source,
          source_message_id,
          first_observed_at,
          last_confirmed_at,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          category = excluded.category,
          key_text = excluded.key_text,
          value_text = excluded.value_text,
          confidence = excluded.confidence,
          source = excluded.source,
          source_message_id = excluded.source_message_id,
          first_observed_at = excluded.first_observed_at,
          last_confirmed_at = excluded.last_confirmed_at,
          status = excluded.status
      `)
      .run(
        record.memoryId,
        record.category,
        record.key,
        record.valueText,
        record.confidence,
        record.source,
        record.sourceMessageId ?? null,
        record.firstObservedAt,
        record.lastConfirmedAt,
        record.status,
      );
  }
}

class SqliteDiaryRepository implements DiaryRepository {
  constructor(private readonly database: Database) {}

  async getByDate(date: string): Promise<DiaryEntry | null> {
    const row = this.database
      .prepare(`
        SELECT
          diary_id AS diaryId,
          date,
          diary_text AS diaryText,
          highlights_json AS highlightsJson,
          memory_count AS memoryCount,
          generated_at AS generatedAt
        FROM diary_entries
        WHERE date = ?
        LIMIT 1
      `)
      .get(date) as SqliteDiaryRow | undefined;

    return row ? mapDiaryEntry(row) : null;
  }

  async upsert(entry: DiaryEntry): Promise<DiaryEntry> {
    this.database
      .prepare(`
        INSERT INTO diary_entries (
          diary_id,
          date,
          diary_text,
          highlights_json,
          memory_count,
          generated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          diary_id = excluded.diary_id,
          diary_text = excluded.diary_text,
          highlights_json = excluded.highlights_json,
          memory_count = excluded.memory_count,
          generated_at = excluded.generated_at
      `)
      .run(
        entry.diaryId,
        entry.date,
        entry.diaryText,
        entry.highlightsJson,
        entry.memoryCount,
        entry.generatedAt,
      );

    return entry;
  }

  async listRecent(limit: number): Promise<DiaryEntry[]> {
    return this.database
      .prepare(`
        SELECT
          diary_id AS diaryId,
          date,
          diary_text AS diaryText,
          highlights_json AS highlightsJson,
          memory_count AS memoryCount,
          generated_at AS generatedAt
        FROM diary_entries
        ORDER BY generated_at DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => mapDiaryEntry(row as SqliteDiaryRow));
  }
}

class SqlitePetStateRepository implements PetStateRepository {
  constructor(private readonly database: Database) {}

  async appendSnapshot(snapshot: PetStateSnapshotRecord): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO pet_state_snapshots (
          snapshot_id,
          business_state,
          visual_state,
          mood,
          trigger,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.snapshotId,
        snapshot.businessState,
        snapshot.visualState,
        snapshot.mood,
        snapshot.trigger,
        snapshot.createdAt,
      );
  }

  async getLatest(): Promise<PetStateSnapshotRecord | null> {
    const row = this.database
      .prepare(`
        SELECT
          snapshot_id AS snapshotId,
          business_state AS businessState,
          visual_state AS visualState,
          mood,
          trigger,
          created_at AS createdAt
        FROM pet_state_snapshots
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get() as SqlitePetStateRow | undefined;

    return row ? mapPetStateSnapshot(row) : null;
  }

  async listRecent(limit: number): Promise<PetStateSnapshotRecord[]> {
    return this.database
      .prepare(`
        SELECT
          snapshot_id AS snapshotId,
          business_state AS businessState,
          visual_state AS visualState,
          mood,
          trigger,
          created_at AS createdAt
        FROM pet_state_snapshots
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => mapPetStateSnapshot(row as SqlitePetStateRow));
  }
}

class SqliteReminderLogRepository implements ReminderLogRepository {
  constructor(private readonly database: Database) {}

  async append(record: ReminderRecord): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO reminder_records (
          reminder_id,
          category,
          source,
          priority,
          status,
          text,
          triggered_at,
          acknowledged_at,
          suppression_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.reminderId,
        record.category,
        record.source,
        record.priority,
        record.status,
        record.text,
        record.triggeredAt,
        record.acknowledgedAt ?? null,
        record.suppressionReason ?? null,
      );
  }

  async acknowledge(params: {
    reminderId: string;
    status: "dismissed" | "opened_chat";
    acknowledgedAt: string;
  }): Promise<void> {
    this.database
      .prepare(`
        UPDATE reminder_records
        SET status = ?, acknowledged_at = ?
        WHERE reminder_id = ?
      `)
      .run(params.status, params.acknowledgedAt, params.reminderId);
  }

  async update(params: {
    reminderId: string;
    status: ReminderRecord["status"];
    triggeredAt?: string;
    acknowledgedAt?: string | null;
    suppressionReason?: string | null;
  }): Promise<void> {
    const updates = ["status = ?"];
    const values: Array<string | null> = [params.status];

    if (params.triggeredAt !== undefined) {
      updates.push("triggered_at = ?");
      values.push(params.triggeredAt);
    }

    if (params.acknowledgedAt !== undefined) {
      updates.push("acknowledged_at = ?");
      values.push(params.acknowledgedAt);
    }

    if (params.suppressionReason !== undefined) {
      updates.push("suppression_reason = ?");
      values.push(params.suppressionReason);
    }

    values.push(params.reminderId);

    this.database
      .prepare(`
        UPDATE reminder_records
        SET ${updates.join(", ")}
        WHERE reminder_id = ?
      `)
      .run(...values);
  }

  async listRecent(params: {
    since?: string;
    limit: number;
  }): Promise<ReminderRecord[]> {
    const rows = params.since
      ? this.database
          .prepare(`
            SELECT
              reminder_id AS reminderId,
              category,
              source,
              priority,
              status,
              text,
              triggered_at AS triggeredAt,
              acknowledged_at AS acknowledgedAt,
              suppression_reason AS suppressionReason
            FROM reminder_records
            WHERE triggered_at >= ?
            ORDER BY triggered_at DESC
            LIMIT ?
          `)
          .all(params.since, params.limit)
      : this.database
          .prepare(`
            SELECT
              reminder_id AS reminderId,
              category,
              source,
              priority,
              status,
              text,
              triggered_at AS triggeredAt,
              acknowledged_at AS acknowledgedAt,
              suppression_reason AS suppressionReason
            FROM reminder_records
            ORDER BY triggered_at DESC
            LIMIT ?
          `)
          .all(params.limit);

    return rows.map((row) => mapReminderRecord(row as SqliteReminderRow));
  }

  async listPendingDue(params: {
    before: string;
    limit: number;
  }): Promise<ReminderRecord[]> {
    return this.database
      .prepare(`
        SELECT
          reminder_id AS reminderId,
          category,
          source,
          priority,
          status,
          text,
          triggered_at AS triggeredAt,
          acknowledged_at AS acknowledgedAt,
          suppression_reason AS suppressionReason
        FROM reminder_records
        WHERE status = 'pending' AND source = 'manual' AND triggered_at <= ?
        ORDER BY triggered_at ASC
        LIMIT ?
      `)
      .all(params.before, params.limit)
      .map((row) => mapReminderRecord(row as SqliteReminderRow));
  }

  async listRecentBySource(params: {
    source: ReminderRecord["source"];
    since: string;
  }): Promise<ReminderRecord[]> {
    return this.database
      .prepare(`
        SELECT
          reminder_id AS reminderId,
          category,
          source,
          priority,
          status,
          text,
          triggered_at AS triggeredAt,
          acknowledged_at AS acknowledgedAt,
          suppression_reason AS suppressionReason
        FROM reminder_records
        WHERE source = ? AND triggered_at >= ?
        ORDER BY triggered_at DESC
      `)
      .all(params.source, params.since)
      .map((row) => mapReminderRecord(row as SqliteReminderRow));
  }
}

export type SqliteRepositoryOptions = {
  databaseFilePath: string;
};

export const resolveLocalServiceDatabaseFilePath = (): string => {
  const configuredPath = process.env.APP_DATABASE_FILE ?? process.env.DB_PATH;
  if (configuredPath) {
    return resolve(configuredPath);
  }

  const environmentDir =
    process.env.NODE_ENV === "production" ? "prod" : "dev";

  return resolve(process.cwd(), "data", environmentDir, "local-service.sqlite3");
};

export const createSqliteRepositories = (
  options: SqliteRepositoryOptions,
): LocalServiceRepositories & { close: () => void } => {
  const database = createDatabase(options.databaseFilePath);

  return {
    conversationRepository: new SqliteConversationRepository(database),
    settingsRepository: new SqliteSettingsRepository(database),
    memoryRepository: new SqliteMemoryRepository(database),
    diaryRepository: new SqliteDiaryRepository(database),
    petStateRepository: new SqlitePetStateRepository(database),
    reminderLogRepository: new SqliteReminderLogRepository(database),
    close: () => { try { database.close(); } catch { /* already closed */ } },
  };
};
