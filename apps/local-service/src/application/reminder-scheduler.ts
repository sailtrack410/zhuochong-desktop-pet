import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPrefixedId, nowIso } from "@zhuochong/shared";

import type { LocalServiceRuntime } from "./runtime.js";
import type {
  AppSettings,
  ConversationSession,
  ReminderRecord,
  PetStateSnapshotRecord,
} from "../domain/models.js";

const defaultTickMs = 15_000;
const defaultGlobalReminderCooldownMs = 18 * 60_000;
const desktopRuntimeStateMaxAgeMs = 15_000;
const manualReminderBatchLimit = 5;

const defaultSourceCooldownMs: Record<ReminderRecord["source"], number> = {
  time: 110 * 60_000,
  battery: 24 * 60_000,
  weather: 120 * 60_000,
  idle: 80 * 60_000,
  calendar: 40 * 60_000,
  manual: 30 * 60_000,
};

type ProactivityLevel = AppSettings["behavior"]["proactivityLevel"];

type ReminderCandidate = {
  source: ReminderRecord["source"];
  category: ReminderRecord["category"];
  priority: ReminderRecord["priority"];
  text: string;
};

type ReminderSilentReason = "focus_mode";

type ReminderSilentState = {
  isSilent: boolean;
  reasons: ReminderSilentReason[];
  detected: {
    frontmostFullscreen: boolean;
    frontmostFullscreenAvailable: boolean;
    focusModeEnabled: boolean;
    focusModeDetectionAvailable: boolean;
  };
};

type DetectionResult = {
  value: boolean;
  available: boolean;
};

type ReminderScheduler = {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
};

const runCommand = (
  command: string,
  args: string[],
  timeoutMs = 1_500,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(String(stdout));
    });
  });

const getDesktopRuntimeStateFilePath = () =>
  process.env.ZHUOCHONG_RUNTIME_STATE_FILE ??
  join(tmpdir(), "zhuochong-desktop-runtime-state.json");

const readDesktopRuntimeDetectionState = (
  key: "fullscreen" | "focusMode",
): DetectionResult | null => {
  const filePath = getDesktopRuntimeStateFilePath();
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      checkedAt?: string;
      fullscreen?: DetectionResult;
      focusMode?: DetectionResult;
    };
    const detection = parsed[key];
    if (
      !detection ||
      typeof detection.value !== "boolean" ||
      typeof detection.available !== "boolean" ||
      typeof parsed.checkedAt !== "string"
    ) {
      return null;
    }

    const checkedAtMs = Date.parse(parsed.checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      return null;
    }

    if (Date.now() - checkedAtMs > desktopRuntimeStateMaxAgeMs) {
      return null;
    }

    return detection;
  } catch {
    return null;
  }
};

const readDesktopRuntimeFullscreenState = (): DetectionResult | null =>
  readDesktopRuntimeDetectionState("fullscreen");

const readDesktopRuntimeFocusModeState = (): DetectionResult | null =>
  readDesktopRuntimeDetectionState("focusMode");

const toEpochMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isWakeHours = (now: Date, level: ProactivityLevel): boolean => {
  const hour = now.getHours();
  if (level === "high") {
    return hour >= 7 && hour <= 23;
  }

  return hour >= 8 && hour <= 23;
};

const isCompanionTick = (now: Date, level: ProactivityLevel): boolean => {
  const minute = now.getMinutes();
  if (level === "high") {
    return minute % 10 === 0;
  }

  return minute <= 1 || minute >= 59;
};

const getIdleThresholdMs = (
  level: ProactivityLevel,
): number => {
  if (level === "high") {
    return 12 * 60_000;
  }

  if (level === "medium") {
    return 85 * 60_000;
  }

  return 130 * 60_000;
};

const getGlobalReminderCooldownMs = (level: ProactivityLevel): number => {
  if (level === "high") {
    return 6 * 60_000;
  }

  return defaultGlobalReminderCooldownMs;
};

const getSourceReminderCooldownMs = (
  source: ReminderRecord["source"],
  level: ProactivityLevel,
): number => {
  if (level === "high") {
    if (source === "time") {
      return 10 * 60_000;
    }

    if (source === "idle") {
      return 18 * 60_000;
    }
  }

  return defaultSourceCooldownMs[source];
};

const getCompanionQuietThresholdMs = (level: ProactivityLevel): number => {
  if (level === "high") {
    return 5 * 60_000;
  }

  return 10 * 60_000;
};


const createCompanionText = (params: {
  now: Date;
  lastMessageAgeMs: number;
  foregroundAppName?: string | null;
  pendingReminderCount?: number;
}): string => {
  const hour = params.now.getHours();
  const quietMinutes = Math.max(1, Math.round(params.lastMessageAgeMs / 60_000));
  const appName = params.foregroundAppName?.trim();
  const pendingHint =
    params.pendingReminderCount && params.pendingReminderCount > 0
      ? `还有 ${params.pendingReminderCount} 条待办别忘了。`
      : null;

  const morningLines = [
    "早上先慢一点也没关系，喝口水再继续。",
    "新的一段开始了，我先陪你热热身。",
    "上午别一直闷头忙，记得给自己一点缓冲。",
    pendingHint ? `早上好，${pendingHint}` : "今天也一起稳稳推进。",
  ];
  const afternoonLines = [
    "下午最容易越忙越累，起来活动两分钟吧。",
    "忙到现在了，眨眨眼也算是在照顾自己。",
    appName ? `${appName} 开着有一阵子了，歇一下再冲。` : "下午这会儿最适合短暂放松一下。",
    pendingHint ? `下午别只顾赶进度，${pendingHint}` : "如果肩膀已经紧了，就顺手伸个懒腰。",
  ];
  const eveningLines = [
    "今天已经很努力了，收尾前也别忘了放松眼睛。",
    "晚上如果还要继续，我会提醒你别太撑。",
    appName ? `${appName} 到现在还开着，记得照顾下自己。` : "夜里忙事情的时候，也要给自己留点余地。",
    pendingHint ? `今晚还有事的话，${pendingHint}` : "收尾前先呼一口气，会更轻松一点。",
  ];
  const longQuietLines = [
    "我安静陪了你好一阵子啦，要不要和我说句话？",
    `已经埋头 ${quietMinutes} 分钟了，休息一下也不会耽误你。`,
    appName ? `${appName} 挺久了，我来提醒你活动一下。` : `你已经专心 ${quietMinutes} 分钟了，换口气吧。`,
  ];

  const pool = quietMinutes >= 90
    ? longQuietLines
    : hour < 12
      ? morningLines
      : hour < 18
        ? afternoonLines
        : eveningLines;

  return pool[Math.floor(Math.random() * pool.length)]!;
};

const createIdleText = (params: {
  idleMinutes: number;
  foregroundAppName?: string | null;
  pendingReminderCount?: number;
}): string => {
  const appName = params.foregroundAppName?.trim();
  const pendingHint =
    params.pendingReminderCount && params.pendingReminderCount > 0
      ? `还有 ${params.pendingReminderCount} 条待办在等你。`
      : null;

  const longIdleLines = [
    "好久没互动啦，我还在这儿陪着你。",
    "你安静了挺久，我就轻轻冒个泡看看你。",
    pendingHint ? `你已经空下来一阵子了，${pendingHint}` : "如果是在发呆，也算是在给自己留白。",
  ];

  const busyIdleLines = [
    "你已经忙了一阵子，要不要喝口水休息下？",
    appName ? `${appName} 开着挺久了，起来活动一下吧。` : "专注久了也会累，我提醒你松一松。",
    pendingHint ? `别只顾着忙，${pendingHint}` : "先活动两分钟，回来会更顺。",
  ];

  const pool = params.idleMinutes >= 150 ? longIdleLines : busyIdleLines;
  return pool[Math.floor(Math.random() * pool.length)]!;
};

const createBatteryText = (params: {
  percent: number;
  foregroundAppName?: string | null;
}): string => {
  const appName = params.foregroundAppName?.trim();
  const criticalLines = [
    `电量只剩 ${params.percent}% 了，先接上电源比较安心。`,
    `只剩 ${params.percent}% 电量啦，我有点担心你会突然断电。`,
    appName
      ? `${appName} 还开着，电量却只剩 ${params.percent}% 了，先充电吧。`
      : `现在只有 ${params.percent}% 电量，最好先补电。`,
  ];
  const warningLines = [
    `电量剩下 ${params.percent}% 了，记得找机会充电。`,
    `我帮你盯了一眼，现在电量 ${params.percent}% 左右。`,
    appName
      ? `${appName} 还在前台，电量也降到 ${params.percent}% 了。`
      : `电量已经到 ${params.percent}% 了，别忘了电源。`,
  ];

  const pool = params.percent <= 12 ? criticalLines : warningLines;
  return pool[Math.floor(Math.random() * pool.length)]!;
};

const detectForegroundAppName = async (): Promise<string | null> => {
  if (process.platform !== "darwin") {
    return null;
  }

  const script = [
    'tell application "System Events"',
    'set frontProc to first process whose frontmost is true',
    'return name of frontProc',
    'end tell',
  ].join("\n");

  try {
    const output = await runCommand("osascript", ["-e", script], 1_200);
    const name = output.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
};

const countPendingManualReminders = async (
  runtime: LocalServiceRuntime,
): Promise<number> => {
  const records = await runtime.repositories.reminderLogRepository.listRecent({
    limit: 50,
  });

  return records.filter(
    (record) => record.source === "manual" && record.status === "pending",
  ).length;
};

const detectBatteryState = async (): Promise<{
  percent: number;
  isCharging: boolean;
} | null> => {
  if (process.platform !== "darwin") {
    return null;
  }

  const output = await runCommand("pmset", ["-g", "batt"]);
  const match = output.match(/(\d{1,3})%/);
  if (!match) {
    return null;
  }

  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null;
  }

  const lower = output.toLowerCase();
  const isCharging =
    (lower.includes("charging") || lower.includes("charged")) &&
    !lower.includes("discharging");

  return {
    percent,
    isCharging,
  };
};


const detectFrontmostFullscreen = async (): Promise<DetectionResult> => {
  if (process.platform !== "darwin") {
    return {
      value: false,
      available: false,
    };
  }

  const desktopRuntimeState = readDesktopRuntimeFullscreenState();
  if (desktopRuntimeState) {
    return desktopRuntimeState;
  }

  const script = [
    'tell application "System Events"',
    "set frontProc to first process whose frontmost is true",
    "try",
    "if (count of windows of frontProc) is 0 then",
    'return "false"',
    "end if",
    'return (value of attribute "AXFullScreen" of window 1 of frontProc) as string',
    "on error",
    'return "false"',
    "end try",
    "end tell",
  ].join("\n");

  try {
    const output = await runCommand("osascript", ["-e", script]);
    return {
      value: output.trim().toLowerCase() === "true",
      available: true,
    };
  } catch {
    return {
      value: false,
      available: false,
    };
  }
};

const detectFocusModeEnabled = async (): Promise<DetectionResult> => {
  if (process.env.ZHUOCHONG_FORCE_FOCUS_MODE === "1") {
    return {
      value: true,
      available: true,
    };
  }

  if (process.platform !== "darwin") {
    return {
      value: false,
      available: false,
    };
  }

  const desktopRuntimeState = readDesktopRuntimeFocusModeState();
  if (desktopRuntimeState?.available) {
    return desktopRuntimeState;
  }

  try {
    const output = await runCommand("defaults", [
      "read",
      "com.apple.controlcenter",
      "NSStatusItem VisibleCC FocusModes",
    ]);
    const value = output.trim().toLowerCase();
    return {
      value: value === "1" || value === "true",
      available: true,
    };
  } catch {
    try {
      const output = await runCommand("defaults", [
        "read",
        "com.apple.controlcenter",
        "NSStatusItem Preferred Position FocusModes",
      ]);
      const value = output.trim().toLowerCase();
      return {
        value: value.length > 0 && value !== "0",
        available: true,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("does not exist")) {
        return {
          value: false,
          available: true,
        };
      }

      return {
        value: false,
        available: false,
      };
    }
  }
};

const buildCandidates = async (params: {
  runtime: LocalServiceRuntime;
  session: ConversationSession;
  settings: AppSettings;
  now: Date;
}): Promise<ReminderCandidate[]> => {
  const candidates: ReminderCandidate[] = [];
  const nowMs = params.now.getTime();
  const lastMessageAgeMs = nowMs - toEpochMs(params.session.lastMessageAt);
  const latestMessage =
    await params.runtime.repositories.conversationRepository.listRecentMessages({
      sessionId: params.session.sessionId,
      limit: 1,
    });
  const [foregroundAppName, pendingReminderCount] = await Promise.all([
    params.settings.capabilities.foregroundAppEnabled
      ? detectForegroundAppName()
      : Promise.resolve(null),
    countPendingManualReminders(params.runtime),
  ]);

  if (
    latestMessage.length === 0 &&
    isWakeHours(params.now, params.settings.behavior.proactivityLevel)
  ) {
    candidates.push({
      source: "time",
      category: "companion",
      priority: "low",
      text:
        pendingReminderCount > 0
          ? `我已经在桌面待命啦，顺便提醒你还有 ${pendingReminderCount} 条待办。`
          : "我已经在桌面待命啦，需要我就戳我一下。",
    });
  }

  try {
    const batteryState = await detectBatteryState();
    if (batteryState && !batteryState.isCharging && batteryState.percent <= 20) {
      candidates.push({
        source: "battery",
        category: "task",
        priority: batteryState.percent <= 12 ? "high" : "medium",
        text: createBatteryText({
          percent: batteryState.percent,
          foregroundAppName,
        }),
      });
    }
  } catch {
    // Battery is optional in MVP; skip when unavailable.
  }

  if (isWakeHours(params.now, params.settings.behavior.proactivityLevel)) {
    const idleThresholdMs = getIdleThresholdMs(params.settings.behavior.proactivityLevel);
    if (lastMessageAgeMs >= idleThresholdMs) {
      candidates.push({
        source: "idle",
        category: "status",
        priority: "medium",
        text: createIdleText({
          idleMinutes: Math.round(lastMessageAgeMs / 60_000),
          foregroundAppName,
          pendingReminderCount,
        }),
      });
    }
  }

  const canCompanionSpeak =
    params.settings.behavior.proactivityLevel !== "low" &&
    isWakeHours(params.now, params.settings.behavior.proactivityLevel) &&
    isCompanionTick(params.now, params.settings.behavior.proactivityLevel) &&
    lastMessageAgeMs >=
      getCompanionQuietThresholdMs(params.settings.behavior.proactivityLevel);

  if (canCompanionSpeak) {
    candidates.push({
      source: "time",
      category: "companion",
      priority: "low",
      text: createCompanionText({
        now: params.now,
        lastMessageAgeMs,
        foregroundAppName,
        pendingReminderCount,
      }),
    });
  }

  return candidates;
};

const getReminderSilentState = async (
  settings: AppSettings,
): Promise<ReminderSilentState> => {
  const reasons: ReminderSilentReason[] = [];
  let frontmostFullscreen = false;
  let frontmostFullscreenAvailable = false;
  let focusModeEnabled = false;
  let focusModeDetectionAvailable = false;

  if (settings.behavior.silentWhenFocusMode) {
    const focusModeState = await detectFocusModeEnabled();
    focusModeEnabled = focusModeState.value;
    focusModeDetectionAvailable = focusModeState.available;
    if (focusModeState.value) {
      reasons.push("focus_mode");
    }
  }

  return {
    isSilent: reasons.length > 0,
    reasons,
    detected: {
      frontmostFullscreen,
      frontmostFullscreenAvailable,
      focusModeEnabled,
      focusModeDetectionAvailable,
    },
  };
};

export const getReminderRuntimeStatus = async (
  runtime: LocalServiceRuntime,
) => {
  const settings = await runtime.repositories.settingsRepository.get();
  const silentState = await getReminderSilentState(settings);

  return {
    remindersEnabled: settings.behavior.remindersEnabled,
    proactivityLevel: settings.behavior.proactivityLevel,
    silentWhenFullscreen: false,
    silentWhenFocusMode: settings.behavior.silentWhenFocusMode,
    isSilent: settings.behavior.remindersEnabled ? silentState.isSilent : false,
    activeSilentReasons: silentState.reasons,
    detected: silentState.detected,
    checkedAt: nowIso(),
  };
};

const hasRecentGlobalReminder = async (
  runtime: LocalServiceRuntime,
  level: ProactivityLevel,
  nowMs: number,
): Promise<boolean> => {
  const recent = await runtime.repositories.reminderLogRepository.listRecent({
    since: new Date(nowMs - getGlobalReminderCooldownMs(level)).toISOString(),
    limit: 50,
  });

  return recent.some(
    (record) =>
      record.status !== "suppressed" &&
      record.status !== "pending" &&
      toEpochMs(record.triggeredAt) <= nowMs,
  );
};

const hasRecentSourceReminder = async (
  runtime: LocalServiceRuntime,
  source: ReminderRecord["source"],
  level: ProactivityLevel,
  nowMs: number,
): Promise<boolean> => {
  const recent = await runtime.repositories.reminderLogRepository.listRecentBySource({
    source,
    since: new Date(nowMs - getSourceReminderCooldownMs(source, level)).toISOString(),
  });

  return recent.some(
    (record) =>
      record.status !== "pending" && toEpochMs(record.triggeredAt) <= nowMs,
  );
};

const appendReminderRecord = async (params: {
  runtime: LocalServiceRuntime;
  candidate: ReminderCandidate;
  status: ReminderRecord["status"];
  triggeredAt: string;
  reminderId: string;
  suppressionReason?: string;
}) => {
  const record: ReminderRecord = {
    reminderId: params.reminderId,
    category: params.candidate.category,
    source: params.candidate.source,
    priority: params.candidate.priority,
    status: params.status,
    text: params.candidate.text,
    triggeredAt: params.triggeredAt,
    ...(params.suppressionReason
      ? {
          suppressionReason: params.suppressionReason,
        }
      : {}),
  };

  await params.runtime.repositories.reminderLogRepository.append(record);
};

const deliverReminder = async (params: {
  runtime: LocalServiceRuntime;
  session: ConversationSession;
  candidate: ReminderCandidate;
  reminderId: string;
  now: string;
}) => {
  await params.runtime.repositories.conversationRepository.appendMessage({
    messageId: createPrefixedId("msg"),
    sessionId: params.session.sessionId,
    role: "assistant",
    source: "reminder",
    text: params.candidate.text,
    relatedReminderId: params.reminderId,
    createdAt: params.now,
  });

  await params.runtime.repositories.conversationRepository.touchSession(
    params.session.sessionId,
    params.now,
  );

  const reminderSnapshot: PetStateSnapshotRecord = {
    snapshotId: createPrefixedId("pet"),
    businessState: "reminding",
    visualState: "click",
    mood: params.candidate.source === "battery" ? "concerned" : "curious",
    trigger: "reminder",
    createdAt: params.now,
  };

  await params.runtime.repositories.petStateRepository.appendSnapshot(
    reminderSnapshot,
  );
};

const emitReminder = async (params: {
  runtime: LocalServiceRuntime;
  session: ConversationSession;
  candidate: ReminderCandidate;
  now: string;
}) => {
  const reminderId = createPrefixedId("reminder");

  await appendReminderRecord({
    runtime: params.runtime,
    candidate: params.candidate,
    status: "ready",
    triggeredAt: params.now,
    reminderId,
  });

  await deliverReminder({
    runtime: params.runtime,
    session: params.session,
    candidate: params.candidate,
    reminderId,
    now: params.now,
  });
};

const toReminderCandidate = (
  record: ReminderRecord,
): ReminderCandidate => ({
  source: record.source,
  category: record.category,
  priority: record.priority,
  text: record.text,
});

const consumeDueManualReminders = async (params: {
  runtime: LocalServiceRuntime;
  session: ConversationSession;
  settings: AppSettings;
  now: string;
}): Promise<boolean> => {
  const dueReminders =
    await params.runtime.repositories.reminderLogRepository.listPendingDue({
      before: params.now,
      limit: manualReminderBatchLimit,
    });

  if (dueReminders.length === 0) {
    return false;
  }

  const silentState = await getReminderSilentState(params.settings);
  if (silentState.isSilent) {
    return false;
  }

  for (const reminder of dueReminders) {
    await params.runtime.repositories.reminderLogRepository.update({
      reminderId: reminder.reminderId,
      status: "ready",
      suppressionReason: null,
    });

    await deliverReminder({
      runtime: params.runtime,
      session: params.session,
      candidate: toReminderCandidate(reminder),
      reminderId: reminder.reminderId,
      now: params.now,
    });
  }

  return true;
};

export const runReminderSchedulerTick = async (
  runtime: LocalServiceRuntime,
): Promise<void> => {
  const settings = await runtime.repositories.settingsRepository.get();
  if (!settings.behavior.remindersEnabled) {
    return;
  }

  const now = new Date();
  const nowMs = now.getTime();
  const nowIsoString = nowIso();
  const activeSession =
    await runtime.repositories.conversationRepository.getOrCreateActiveSession();

  if (
    await consumeDueManualReminders({
      runtime,
      session: activeSession,
      settings,
      now: nowIsoString,
    })
  ) {
    return;
  }

  const candidates = await buildCandidates({
    runtime,
    session: activeSession,
    settings,
    now,
  });

  if (candidates.length === 0) {
    return;
  }

  const proactivityLevel = settings.behavior.proactivityLevel;

  for (const candidate of candidates) {
    if (
      await hasRecentSourceReminder(
        runtime,
        candidate.source,
        proactivityLevel,
        nowMs,
      )
    ) {
      continue;
    }

    const bypassGlobalCooldown =
      candidate.source === "battery" && candidate.priority === "high";

    if (
      !bypassGlobalCooldown &&
      (await hasRecentGlobalReminder(runtime, proactivityLevel, nowMs))
    ) {
      continue;
    }

    const silentState = await getReminderSilentState(settings);
    const reminderId = createPrefixedId("reminder");

    if (silentState.isSilent) {
      await appendReminderRecord({
        runtime,
        candidate,
        status: "suppressed",
        triggeredAt: nowIsoString,
        reminderId,
        ...(silentState.reasons.length > 0
          ? {
              suppressionReason: silentState.reasons.join("+"),
            }
          : {}),
      });
      return;
    }

    await emitReminder({
      runtime,
      session: activeSession,
      candidate,
      now: nowIsoString,
    });
    return;
  }
};

export const createReminderScheduler = (
  runtime: LocalServiceRuntime,
  options?: {
    tickMs?: number;
  },
): ReminderScheduler => {
  let timer: NodeJS.Timeout | null = null;
  let isTicking = false;

  const runOnce = async () => {
    if (isTicking) {
      return;
    }

    isTicking = true;

    try {
      await runReminderSchedulerTick(runtime);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        "[local-service] reminder scheduler tick failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      isTicking = false;
    }
  };

  return {
    start: () => {
      if (timer) {
        return;
      }

      const tickMs = options?.tickMs ?? defaultTickMs;
      timer = setInterval(() => {
        void runOnce();
      }, tickMs);

      void runOnce();
    },
    stop: () => {
      if (!timer) {
        return;
      }

      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
};
