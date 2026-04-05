import type {
  PetComposerAutoHideSeconds,
  PetBusinessState,
  PetMoveDistance,
  PetMood,
  PetMotionFrequency,
  PetSleepTendency,
  PetVisualState,
  ProactivityLevel,
  ReminderCategory,
  ReminderSource,
} from "@zhuochong/ui-contracts";

export type MemoryCategory =
  | "preference"
  | "habit"
  | "profile"
  | "event"
  | "relationship";

export type AppSettings = {
  settingsId: "default";
  model: {
    baseUrl: string;
    modelName: string;
    apiKeyEncrypted?: string;
  };
  behavior: {
    proactivityLevel: ProactivityLevel;
    remindersEnabled: boolean;
    silentWhenFullscreen: boolean;
    silentWhenFocusMode: boolean;
  };
  pet: {
    displayName: string;
    pixelScale: 1 | 2 | 3 | 4;
    motionFrequency: PetMotionFrequency;
    sleepTendency: PetSleepTendency;
    moveDistance: PetMoveDistance;
    composerAutoHideSeconds: PetComposerAutoHideSeconds;
  };
  capabilities: {
    calendarEnabled: boolean;
    weatherEnabled: boolean;
    foregroundAppEnabled: boolean;
    ttsEnabled: boolean;
  };
  updatedAt: string;
};

export type SettingsPatch = {
  model?: {
    baseUrl?: string;
    modelName?: string;
    apiKeyInput?: string;
    clearApiKey?: boolean;
  };
  behavior?: {
    proactivityLevel?: ProactivityLevel;
    remindersEnabled?: boolean;
    silentWhenFullscreen?: boolean;
    silentWhenFocusMode?: boolean;
  };
  pet?: {
    displayName?: string;
    pixelScale?: 1 | 2 | 3 | 4;
    motionFrequency?: PetMotionFrequency;
    sleepTendency?: PetSleepTendency;
    moveDistance?: PetMoveDistance;
    composerAutoHideSeconds?: PetComposerAutoHideSeconds;
  };
  capabilities?: {
    calendarEnabled?: boolean;
    weatherEnabled?: boolean;
    foregroundAppEnabled?: boolean;
    ttsEnabled?: boolean;
  };
};

export type ConversationSession = {
  sessionId: string;
  status: "active" | "archived";
  startedAt: string;
  lastMessageAt: string;
};

export type ConversationMessage = {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  source: "chat" | "reminder" | "system";
  text: string;
  createdAt: string;
  relatedReminderId?: string;
};

export type MemoryRecord = {
  memoryId: string;
  category: MemoryCategory;
  key: string;
  valueText: string;
  confidence: number;
  source: "conversation" | "derived";
  sourceMessageId?: string;
  firstObservedAt: string;
  lastConfirmedAt: string;
  status: "active" | "superseded" | "discarded";
};

export type DiaryEntry = {
  diaryId: string;
  date: string;
  diaryText: string;
  highlightsJson: string;
  memoryCount: number;
  generatedAt: string;
};

export type PetStateSnapshotRecord = {
  snapshotId: string;
  businessState: PetBusinessState;
  visualState: PetVisualState;
  mood: PetMood;
  trigger: "chat" | "reminder" | "system" | "drag" | "manual";
  createdAt: string;
};

export type ReminderRecord = {
  reminderId: string;
  category: ReminderCategory;
  source: ReminderSource;
  priority: "low" | "medium" | "high";
  status: "pending" | "ready" | "dismissed" | "opened_chat" | "suppressed";
  text: string;
  triggeredAt: string;
  acknowledgedAt?: string;
  suppressionReason?: string;
};
