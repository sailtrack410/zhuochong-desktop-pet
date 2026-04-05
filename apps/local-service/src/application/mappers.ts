import { nowIso } from "@zhuochong/shared";
import type {
  ChatMessageDto,
  ChatSessionDto,
  CapabilityInfo,
  DiaryEntryDto,
  MemoryRecordDto,
  PetStateSnapshot,
  ReminderRecordDto,
  SettingsDto,
  SettingsUpdateRequest,
  SystemContextDto,
} from "@zhuochong/ui-contracts";

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

const toCapabilityState = (enabled: boolean) =>
  enabled ? "ok" : "disabled";

export const mapSettingsToDto = (settings: AppSettings): SettingsDto => ({
  model: {
    baseUrl: settings.model.baseUrl,
    modelName: settings.model.modelName,
    apiKeyState: settings.model.apiKeyEncrypted ? "configured" : "missing",
  },
  behavior: {
    proactivityLevel: settings.behavior.proactivityLevel,
    remindersEnabled: settings.behavior.remindersEnabled,
    silentWhenFullscreen: settings.behavior.silentWhenFullscreen,
    silentWhenFocusMode: settings.behavior.silentWhenFocusMode,
  },
  pet: {
    displayName: settings.pet.displayName,
    pixelScale: settings.pet.pixelScale,
    motionFrequency: settings.pet.motionFrequency,
    sleepTendency: settings.pet.sleepTendency,
    moveDistance: settings.pet.moveDistance,
    composerAutoHideSeconds: settings.pet.composerAutoHideSeconds,
  },
  capabilities: {
    calendar: toCapabilityState(settings.capabilities.calendarEnabled),
    weather: toCapabilityState(settings.capabilities.weatherEnabled),
    foregroundApp: toCapabilityState(settings.capabilities.foregroundAppEnabled),
    tts: toCapabilityState(settings.capabilities.ttsEnabled),
  },
  updatedAt: settings.updatedAt,
});

export const mapConversationSessionToDto = (
  session: ConversationSession,
): ChatSessionDto => ({
  sessionId: session.sessionId,
  status: session.status,
  startedAt: session.startedAt,
  lastMessageAt: session.lastMessageAt,
});

export const mapConversationMessageToDto = (
  message: ConversationMessage,
): ChatMessageDto => ({
  messageId: message.messageId,
  sessionId: message.sessionId,
  role: message.role,
  source: message.source,
  text: message.text,
  createdAt: message.createdAt,
  ...(message.relatedReminderId
    ? { relatedReminderId: message.relatedReminderId }
    : {}),
});

export const mapSettingsUpdateRequestToPatch = (
  request: SettingsUpdateRequest,
): SettingsPatch => {
  const patch: SettingsPatch = {};

  if (request.patch.model) {
    const modelPatch: NonNullable<SettingsPatch["model"]> = {};

    if (request.patch.model.baseUrl !== undefined) {
      modelPatch.baseUrl = request.patch.model.baseUrl;
    }

    if (request.patch.model.modelName !== undefined) {
      modelPatch.modelName = request.patch.model.modelName;
    }

    if (request.patch.model.apiKeyInput !== undefined) {
      modelPatch.apiKeyInput = request.patch.model.apiKeyInput;
    }

    if (request.patch.model.clearApiKey !== undefined) {
      modelPatch.clearApiKey = request.patch.model.clearApiKey;
    }

    patch.model = modelPatch;
  }

  if (request.patch.behavior) {
    const behaviorPatch: NonNullable<SettingsPatch["behavior"]> = {};

    if (request.patch.behavior.proactivityLevel !== undefined) {
      behaviorPatch.proactivityLevel = request.patch.behavior.proactivityLevel;
    }

    if (request.patch.behavior.remindersEnabled !== undefined) {
      behaviorPatch.remindersEnabled = request.patch.behavior.remindersEnabled;
    }

    if (request.patch.behavior.silentWhenFullscreen !== undefined) {
      behaviorPatch.silentWhenFullscreen =
        request.patch.behavior.silentWhenFullscreen;
    }

    if (request.patch.behavior.silentWhenFocusMode !== undefined) {
      behaviorPatch.silentWhenFocusMode = request.patch.behavior.silentWhenFocusMode;
    }

    patch.behavior = behaviorPatch;
  }

  if (request.patch.pet) {
    const petPatch: NonNullable<SettingsPatch["pet"]> = {};

    if (request.patch.pet.displayName !== undefined) {
      petPatch.displayName = request.patch.pet.displayName;
    }

    if (request.patch.pet.pixelScale !== undefined) {
      petPatch.pixelScale = request.patch.pet.pixelScale;
    }

    if (request.patch.pet.motionFrequency !== undefined) {
      petPatch.motionFrequency = request.patch.pet.motionFrequency;
    }

    if (request.patch.pet.sleepTendency !== undefined) {
      petPatch.sleepTendency = request.patch.pet.sleepTendency;
    }

    if (request.patch.pet.moveDistance !== undefined) {
      petPatch.moveDistance = request.patch.pet.moveDistance;
    }

    if (request.patch.pet.composerAutoHideSeconds !== undefined) {
      petPatch.composerAutoHideSeconds =
        request.patch.pet.composerAutoHideSeconds;
    }

    patch.pet = petPatch;
  }

  if (request.patch.capabilities) {
    const capabilityPatch: NonNullable<SettingsPatch["capabilities"]> = {};

    if (request.patch.capabilities.calendar !== undefined) {
      capabilityPatch.calendarEnabled = request.patch.capabilities.calendar;
    }

    if (request.patch.capabilities.weather !== undefined) {
      capabilityPatch.weatherEnabled = request.patch.capabilities.weather;
    }

    if (request.patch.capabilities.foregroundApp !== undefined) {
      capabilityPatch.foregroundAppEnabled =
        request.patch.capabilities.foregroundApp;
    }

    if (request.patch.capabilities.tts !== undefined) {
      capabilityPatch.ttsEnabled = request.patch.capabilities.tts;
    }

    patch.capabilities = capabilityPatch;
  }

  return patch;
};

const disabledCapability = <TData>(): CapabilityInfo<TData> => ({
  state: "disabled",
});

const unsupportedCapability = <TData>(): CapabilityInfo<TData> => ({
  state: "unsupported",
});

const toCurrentInteraction = (
  snapshot: PetStateSnapshotRecord,
): PetStateSnapshot["currentInteraction"] => {
  if (snapshot.visualState === "drag" || snapshot.trigger === "drag") {
    return "dragging";
  }

  if (snapshot.trigger === "chat") {
    return "chat_panel";
  }

  if (snapshot.trigger === "reminder") {
    return "reminder";
  }

  if (snapshot.visualState === "click") {
    return "bubble";
  }

  return "none";
};

export const mapPetStateRecordToDto = (
  snapshot: PetStateSnapshotRecord,
): PetStateSnapshot => ({
  businessState: snapshot.businessState,
  visualState: snapshot.visualState,
  mood: snapshot.mood,
  canInterrupt:
    snapshot.businessState !== "chatting" && snapshot.visualState !== "drag",
  isSilentMode: false,
  currentInteraction: toCurrentInteraction(snapshot),
  updatedAt: snapshot.createdAt,
});

export const createDefaultPetStateSnapshot = (): PetStateSnapshot => ({
  businessState: "idle",
  visualState: "idle",
  mood: "neutral",
  canInterrupt: true,
  isSilentMode: false,
  currentInteraction: "none",
  updatedAt: nowIso(),
});

export const createDefaultSystemContextDto = (
  settings: AppSettings,
): SystemContextDto => {
  const hour = new Date().getHours();
  const timeOfDay =
    hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night";

  return {
    observedAt: nowIso(),
    timeOfDay,
    battery: unsupportedCapability(),
    idle: unsupportedCapability(),
    weather: settings.capabilities.weatherEnabled
      ? unsupportedCapability()
      : disabledCapability(),
    calendar: settings.capabilities.calendarEnabled
      ? unsupportedCapability()
      : disabledCapability(),
    foregroundApp: settings.capabilities.foregroundAppEnabled
      ? unsupportedCapability()
      : disabledCapability(),
  };
};

export const mapMemoryRecordToDto = (
  record: MemoryRecord,
): MemoryRecordDto => ({
  memoryId: record.memoryId,
  category: record.category,
  key: record.key,
  valueText: record.valueText,
  confidence: record.confidence,
  source: record.source,
  firstObservedAt: record.firstObservedAt,
  lastConfirmedAt: record.lastConfirmedAt,
  status: record.status,
});

export const mapDiaryEntryToDto = (entry: DiaryEntry): DiaryEntryDto => {
  let highlights: string[] = [];
  try {
    highlights = JSON.parse(entry.highlightsJson) as string[];
  } catch {
    highlights = [];
  }

  return {
    diaryId: entry.diaryId,
    date: entry.date,
    diaryText: entry.diaryText,
    highlights,
    memoryCount: entry.memoryCount,
    generatedAt: entry.generatedAt,
  };
};

export const mapReminderRecordToDto = (
  record: ReminderRecord,
): ReminderRecordDto => ({
  reminderId: record.reminderId,
  category: record.category,
  source: record.source,
  priority: record.priority,
  status: record.status,
  text: record.text,
  triggeredAt: record.triggeredAt,
  ...(record.acknowledgedAt
    ? {
        acknowledgedAt: record.acknowledgedAt,
      }
    : {}),
  ...(record.suppressionReason
    ? {
        suppressionReason: record.suppressionReason,
      }
    : {}),
});
