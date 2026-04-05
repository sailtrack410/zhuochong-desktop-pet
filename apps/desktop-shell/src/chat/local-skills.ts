import type {
  ReminderRecordDto,
  ReminderRuntimeStatusDto,
} from "@zhuochong/ui-contracts";

import { desktopLocalService } from "../services/local-service.js";

type SystemInfoSkillRequest = {
  skillId: "system_info";
  wantsTime: boolean;
  wantsForegroundApp: boolean;
  wantsBattery: boolean;
  wantsVolume: boolean;
};

type ManualReminderSkillRequest = {
  skillId: "manual_reminder";
  reminderText?: string;
  dueAtIso?: string;
  displayTimeText?: string;
  parseError?: string;
};

type ProductivitySkillRequest = {
  skillId: "productivity_info";
  scope: ZhuochongProductivityScope;
  maxItems: number;
};

type ReminderRuntimeSkillRequest = {
  skillId: "reminder_runtime";
  wantsOverview: boolean;
  wantsFocusMode: boolean;
  wantsSilentReasons: boolean;
};

type ReminderHistorySkillRequest = {
  skillId: "reminder_history";
  limit: number;
};

export type LocalSkillRequest =
  | SystemInfoSkillRequest
  | ManualReminderSkillRequest
  | ProductivitySkillRequest
  | ReminderRuntimeSkillRequest
  | ReminderHistorySkillRequest;

export type LocalSkillExecutionResult = {
  replyText: string;
  statusText: string;
};

type ReminderPeriod =
  | "dawn"
  | "morning"
  | "noon"
  | "afternoon"
  | "evening";

const reminderVerbPattern = "(?:提醒我|提醒一下我|提醒一下|提醒|叫我)";
const relativeReminderPattern = new RegExp(
  `^\\s*(\\d+)\\s*(秒钟?|分钟?|小时)\\s*后${reminderVerbPattern}\\s*(.+?)\\s*[。！!？?]*$`,
);
const absoluteReminderPattern = new RegExp(
  `^\\s*(.+?)${reminderVerbPattern}\\s*(.+?)\\s*[。！!？?]*$`,
);
const reminderIntentPattern = /(提醒我|提醒一下我|提醒一下|提醒|叫我)/;
const reminderTimeHintPattern =
  /(后|秒钟?|分钟?|小时|今天|明天|今晚|明晚|今早|明早|早上|上午|中午|下午|晚上|夜里|夜晚|傍晚|凌晨|\d{1,2}\s*(点|时|[:：]))/;

const matchesPattern = (value: string, patterns: RegExp[]) =>
  patterns.some((pattern) => pattern.test(value));

const timeQueryPatterns = [
  /几点/,
  /几时/,
  /几号/,
  /星期几/,
  /周几/,
  /几月几号/,
  /(现在|当前|今天|此刻).*(时间|日期)/,
  /\btime\b/i,
  /\bdate\b/i,
] as const;

const foregroundAppQueryPatterns = [
  /前台应用/,
  /当前应用/,
  /前台软件/,
  /当前软件/,
  /前台窗口/,
  /现在打开的应用/,
  /正在用什么应用/,
  /正在使用什么应用/,
  /现在在用什么应用/,
  /\bforeground app\b/i,
  /\bcurrent app\b/i,
] as const;

const batteryQueryPatterns = [
  /电量/,
  /电池/,
  /剩余电/,
  /充电中/,
  /在充电吗/,
  /电池百分比/,
  /\bbattery\b/i,
] as const;

const volumeQueryPatterns = [
  /音量/,
  /静音/,
  /声音大小/,
  /系统音量/,
  /\bvolume\b/i,
  /\bmute\b/i,
] as const;

const overviewQueryPatterns = [
  /系统状态/,
  /设备状态/,
  /电脑状态/,
  /本机状态/,
  /系统信息/,
  /设备信息/,
  /电脑信息/,
  /\bsystem status\b/i,
  /\bdevice status\b/i,
] as const;

const productivityTodayPatterns = [/今天/, /今日/] as const;
const productivityTomorrowPatterns = [/明天/, /明日/] as const;
const productivityReminderPatterns = [
  /待办/,
  /提醒事项/,
  /提醒清单/,
  /待做/,
  /\btodo\b/i,
  /\bto-do\b/i,
  /\breminders?\b/i,
] as const;
const productivityQueryHintPatterns = [
  /有什么/,
  /有哪些/,
  /接下来/,
  /最近/,
  /查看/,
  /查下/,
  /查一下/,
  /列出/,
  /告诉我/,
  /看看/,
  /有没有/,
  /要做什么/,
  /该做什么/,
  /是什么/,
] as const;
const reminderRuntimePatterns = [
  /为什么.*(没提醒|没有提醒|不提醒|没提示|没有提示|静默)/,
  /(提醒|主动提醒|桌宠提醒).*(为什么|原因|状态)/,
  /(现在|当前).*(会提醒|能提醒|可以提醒)/,
  /(主动提醒|提醒功能).*(开了吗|开着吗|开启了吗|状态)/,
  /(提醒|主动提醒).*(触发了吗|为什么没触发)/,
] as const;
const reminderFocusModePatterns = [
  /专注模式.*(开了吗|开着吗|状态|开启了吗|关闭了吗)/,
  /(提醒|主动提醒).*(专注模式|勿扰|focus mode)/i,
] as const;
const reminderHistoryPatterns = [
  /最近.*提醒了什么/,
  /刚刚.*提醒了什么/,
  /最近.*提醒记录/,
  /提醒记录/,
  /上一次提醒/,
  /最近弹了什么提醒/,
  /最近通知了什么/,
] as const;

const pad2 = (value: number) => String(value).padStart(2, "0");
const reminderSilentReasonLabels: Record<
  ReminderRuntimeStatusDto["activeSilentReasons"][number],
  string
> = {
  fullscreen: "前台窗口处于全屏",
  focus_mode: "系统专注模式已开启",
};
const reminderSourceLabels: Record<ReminderRecordDto["source"], string> = {
  time: "时间",
  battery: "电量",
  weather: "天气",
  idle: "陪伴",
  calendar: "日历",
  manual: "手动",
};
const reminderRecordStatusLabels: Record<ReminderRecordDto["status"], string> = {
  pending: "待触发",
  ready: "已提醒",
  dismissed: "已忽略",
  opened_chat: "已打开对话",
  suppressed: "已静默",
};

const isSameDate = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
};

const formatReminderDisplayTime = (dueAt: Date, now: Date) => {
  const timeText = `${pad2(dueAt.getHours())}:${pad2(dueAt.getMinutes())}`;
  if (isSameDate(dueAt, now)) {
    return `今天 ${timeText}`;
  }

  const tomorrow = addDays(now, 1);
  if (isSameDate(dueAt, tomorrow)) {
    return `明天 ${timeText}`;
  }

  return `${dueAt.getMonth() + 1}月${dueAt.getDate()}日 ${timeText}`;
};

const normalizeReminderText = (value: string) =>
  value.trim().replace(/^[，,：:\s]+/, "").replace(/[。！!？?]+$/, "").trim();

const formatClockTime = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

const formatScopedDateTime = (
  value: string,
  scope: ZhuochongProductivityScope,
) => {
  const date = new Date(value);
  const now = new Date();
  const tomorrow = addDays(now, 1);
  const timeText = formatClockTime(value);

  if (scope === "today" && isSameDate(date, now)) {
    return `今天 ${timeText}`;
  }

  if (scope === "tomorrow" && isSameDate(date, tomorrow)) {
    return `明天 ${timeText}`;
  }

  if (isSameDate(date, now)) {
    return `今天 ${timeText}`;
  }

  if (isSameDate(date, tomorrow)) {
    return `明天 ${timeText}`;
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}月${day}日 ${timeText}`;
};

const formatReminderDueTime = (
  item: ZhuochongReminderItem,
  scope: ZhuochongProductivityScope,
) => {
  if (!item.dueAt) {
    return "未设置时间";
  }

  if (scope === "upcoming") {
    return formatScopedDateTime(item.dueAt, scope);
  }

  return formatClockTime(item.dueAt);
};

const getProductivitySourceErrorText = (
  snapshot: ZhuochongProductivitySnapshot,
) => snapshot.errors.reminders ?? "系统提醒事项暂时不可用。";

const formatProductivitySection = (
  title: string,
  items: string[],
  emptyText: string,
) => {
  if (items.length === 0) {
    return emptyText;
  }

  return `${title}：\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
};

const formatReminderRecordTime = (value: string) => {
  const date = new Date(value);
  const now = new Date();
  const todayTime = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isSameDate(date, now)) {
    return `今天 ${todayTime}`;
  }

  const yesterday = addDays(now, -1);
  if (isSameDate(date, yesterday)) {
    return `昨天 ${todayTime}`;
  }

  return `${date.getMonth() + 1}月${date.getDate()}日 ${todayTime}`;
};

const formatProactivityLevelText = (
  value: ReminderRuntimeStatusDto["proactivityLevel"],
) => {
  if (value === "high") {
    return "高";
  }

  if (value === "medium") {
    return "中";
  }

  return "低";
};

const formatReminderRuntimeOverview = (
  status: ReminderRuntimeStatusDto,
) => {
  if (!status.remindersEnabled) {
    return "主动提醒当前已关闭。";
  }

  const proactivityText = `主动性档位是${formatProactivityLevelText(
    status.proactivityLevel,
  )}。`;
  if (status.isSilent) {
    const reasonText =
      status.activeSilentReasons.length > 0
        ? status.activeSilentReasons
            .map((reason) => reminderSilentReasonLabels[reason])
            .join("，")
        : "命中了静默规则";
    return `主动提醒当前处于静默状态，${proactivityText} 原因是${reasonText}。`;
  }

  return `主动提醒当前可用，${proactivityText} 没有命中静默规则。`;
};

const formatReminderFocusModeStatus = (
  status: ReminderRuntimeStatusDto,
) => {
  if (!status.detected.focusModeDetectionAvailable) {
    return "当前无法可靠检测系统专注模式。";
  }

  return `系统专注模式当前${
    status.detected.focusModeEnabled ? "已开启" : "未开启"
  }。`;
};

const formatReminderSilentReasonStatus = (
  status: ReminderRuntimeStatusDto,
) => {
  if (!status.remindersEnabled) {
    return "主动提醒当前已关闭，所以不会触发主动提醒。";
  }

  if (!status.isSilent) {
    return "当前没有命中静默规则。若刚刚没有提醒，更可能是没有触发提醒候选，或者还在提醒节奏冷却里。";
  }

  const reasonText =
    status.activeSilentReasons.length > 0
      ? status.activeSilentReasons
          .map((reason) => reminderSilentReasonLabels[reason])
          .join("，")
      : "命中了静默规则";
  return `当前主动提醒被静默了，原因是${reasonText}。`;
};

const formatReminderHistory = (records: ReminderRecordDto[]) => {
  const visibleRecords = records.filter(
    (record) =>
      record.status !== "pending" && record.status !== "suppressed",
  );

  if (visibleRecords.length === 0) {
    return "最近没有查到已经触发的提醒记录。";
  }

  return `最近提醒记录：\n${visibleRecords
    .map(
      (record, index) =>
        `${index + 1}. ${formatReminderRecordTime(record.triggeredAt)} ${
          record.text
        }（${reminderSourceLabels[record.source]}，${
          reminderRecordStatusLabels[record.status]
        }）`,
    )
    .join("\n")}`;
};

const createManualReminderRequest = (params: {
  reminderText: string;
  dueAt: Date;
  now: Date;
}): ManualReminderSkillRequest => ({
  skillId: "manual_reminder",
  reminderText: params.reminderText,
  dueAtIso: params.dueAt.toISOString(),
  displayTimeText: formatReminderDisplayTime(params.dueAt, params.now),
});

const createManualReminderError = (
  message: string,
): ManualReminderSkillRequest => ({
  skillId: "manual_reminder",
  parseError: message,
});

const getReminderDefaultHour = (period: ReminderPeriod): number => {
  if (period === "dawn") {
    return 7;
  }

  if (period === "morning") {
    return 9;
  }

  if (period === "noon") {
    return 12;
  }

  if (period === "afternoon") {
    return 15;
  }

  return 20;
};

const resolveReminderPeriod = (timeText: string): ReminderPeriod | null => {
  if (/凌晨/.test(timeText)) {
    return "dawn";
  }

  if (/(明早|今早|早上|上午|早晨|清晨)/.test(timeText)) {
    return "morning";
  }

  if (/中午/.test(timeText)) {
    return "noon";
  }

  if (/下午/.test(timeText)) {
    return "afternoon";
  }

  if (/(今晚|明晚|晚上|夜里|夜晚|傍晚)/.test(timeText)) {
    return "evening";
  }

  return null;
};

const to24Hour = (hour: number, period: ReminderPeriod | null): number => {
  if (period === null) {
    return hour;
  }

  if (period === "dawn" || period === "morning") {
    return hour === 12 ? 0 : hour;
  }

  if (period === "noon") {
    if (hour >= 1 && hour <= 10) {
      return hour + 12;
    }

    return hour;
  }

  if (period === "afternoon") {
    if (hour >= 1 && hour <= 11) {
      return hour + 12;
    }

    return hour;
  }

  if (hour === 12) {
    return 0;
  }

  if (hour >= 1 && hour <= 11) {
    return hour + 12;
  }

  return hour;
};

const parseAbsoluteReminderTime = (timeText: string) => {
  const normalizedText = timeText.replace(/\s+/g, "");
  const period = resolveReminderPeriod(normalizedText);
  const explicitDay = /今天|明天|今早|明早|今晚|明晚/.test(normalizedText);
  const dayOffset = /明天|明早|明晚/.test(normalizedText) ? 1 : 0;

  const colonMatch = normalizedText.match(/(\d{1,2})[:：](\d{1,2})/);
  if (colonMatch) {
    const hour = Number(colonMatch[1]);
    const minute = Number(colonMatch[2]);
    if (hour > 23 || minute > 59) {
      return {
        error: "提醒时间看起来不太对，你可以换成下午 3 点或 20 分钟后这种说法。",
      };
    }

    return {
      hour: to24Hour(hour, period),
      minute,
      explicitDay,
      dayOffset,
    };
  }

  const pointMatch = normalizedText.match(/(\d{1,2})(?:点|时)(?:(半)|((?:[0-5]?\d))分?)?/);
  if (pointMatch) {
    const hour = Number(pointMatch[1]);
    const minute = pointMatch[2] ? 30 : pointMatch[3] ? Number(pointMatch[3]) : 0;
    const convertedHour = to24Hour(hour, period);
    if (convertedHour > 23 || minute > 59) {
      return {
        error: "提醒时间看起来不太对，你可以换成下午 3 点或 20 分钟后这种说法。",
      };
    }

    return {
      hour: convertedHour,
      minute,
      explicitDay,
      dayOffset,
    };
  }

  if (period) {
    return {
      hour: getReminderDefaultHour(period),
      minute: 0,
      explicitDay,
      dayOffset,
    };
  }

  return {
    error: "我目前支持“20 分钟后提醒我...”“下午 3 点提醒我...”“明天早上 9 点提醒我...”这几类提醒。",
  };
};

const parseRelativeReminder = (
  text: string,
  now: Date,
): ManualReminderSkillRequest | null => {
  const match = text.match(relativeReminderPattern);
  if (!match) {
    return null;
  }

  const [, amountText = "", unit = "", rawReminderText = ""] = match;
  const amount = Number(amountText);
  const reminderText = normalizeReminderText(rawReminderText);
  if (!Number.isFinite(amount) || amount <= 0 || !reminderText) {
    return createManualReminderError("提醒内容还不完整，你可以说“20 分钟后提醒我拿外卖”。");
  }

  const unitMs = unit.startsWith("秒")
    ? 1_000
    : unit.startsWith("分钟")
      ? 60_000
      : 60 * 60_000;
  const dueAt = new Date(now.getTime() + amount * unitMs);

  return createManualReminderRequest({
    reminderText,
    dueAt,
    now,
  });
};

const parseAbsoluteReminder = (
  text: string,
  now: Date,
): ManualReminderSkillRequest | null => {
  const match = text.match(absoluteReminderPattern);
  if (!match) {
    return null;
  }

  const [, rawTimeText = "", rawReminderText = ""] = match;
  const timeText = rawTimeText.trim();
  const reminderText = normalizeReminderText(rawReminderText);
  if (!reminderText) {
    return createManualReminderError("提醒内容还没告诉我，你可以说“下午 3 点提醒我发周报”。");
  }

  const parsedTime = parseAbsoluteReminderTime(timeText);
  if ("error" in parsedTime) {
    return createManualReminderError(parsedTime.error);
  }

  const dueAt = new Date(now);
  dueAt.setSeconds(0, 0);
  dueAt.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
  if (parsedTime.dayOffset > 0) {
    dueAt.setDate(dueAt.getDate() + parsedTime.dayOffset);
  }

  if (parsedTime.explicitDay) {
    if (dueAt.getTime() <= now.getTime()) {
      return createManualReminderError("这个时间已经过了，你可以换成明天，或者说多少分钟后提醒。");
    }
  } else if (dueAt.getTime() <= now.getTime()) {
    dueAt.setDate(dueAt.getDate() + 1);
  }

  return createManualReminderRequest({
    reminderText,
    dueAt,
    now,
  });
};

const matchManualReminderSkill = (
  text: string,
): ManualReminderSkillRequest | null => {
  if (
    matchesPattern(text, [...productivityReminderPatterns]) &&
    matchesPattern(text, [...productivityQueryHintPatterns]) &&
    !/(提醒我|提醒一下我|叫我)/.test(text)
  ) {
    return null;
  }

  const now = new Date();
  const relativeRequest = parseRelativeReminder(text, now);
  if (relativeRequest) {
    return relativeRequest;
  }

  const absoluteRequest = parseAbsoluteReminder(text, now);
  if (absoluteRequest) {
    return absoluteRequest;
  }

  if (reminderIntentPattern.test(text) && reminderTimeHintPattern.test(text)) {
    return createManualReminderError(
      "我目前支持“20 分钟后提醒我...”“下午 3 点提醒我...”“明天早上 9 点提醒我...”这几类提醒。",
    );
  }

  return null;
};

const matchProductivitySkill = (
  text: string,
): ProductivitySkillRequest | null => {
  const includeReminders = matchesPattern(text, [...productivityReminderPatterns]);
  const hasScope =
    matchesPattern(text, [...productivityTodayPatterns]) ||
    matchesPattern(text, [...productivityTomorrowPatterns]);
  const hasQueryHint = matchesPattern(text, [...productivityQueryHintPatterns]);

  if (!includeReminders || (!hasScope && !hasQueryHint)) {
    return null;
  }

  const scope: ZhuochongProductivityScope = matchesPattern(
    text,
    [...productivityTomorrowPatterns],
  )
    ? "tomorrow"
    : matchesPattern(text, [...productivityTodayPatterns])
      ? "today"
      : "upcoming";

  return {
    skillId: "productivity_info",
    scope,
    maxItems: 5,
  };
};

const matchReminderRuntimeSkill = (
  text: string,
): ReminderRuntimeSkillRequest | null => {
  const wantsFocusMode = matchesPattern(text, [...reminderFocusModePatterns]);
  const wantsSilentReasons = matchesPattern(text, [...reminderRuntimePatterns]);

  if (!wantsFocusMode && !wantsSilentReasons) {
    return null;
  }

  return {
    skillId: "reminder_runtime",
    wantsOverview: wantsSilentReasons || !wantsFocusMode,
    wantsFocusMode,
    wantsSilentReasons,
  };
};

const matchReminderHistorySkill = (
  text: string,
): ReminderHistorySkillRequest | null => {
  if (!matchesPattern(text, [...reminderHistoryPatterns])) {
    return null;
  }

  return {
    skillId: "reminder_history",
    limit: 5,
  };
};

const formatForegroundAppText = (systemInfo: ZhuochongSystemInfo) => {
  if (!systemInfo.foregroundApp) {
    return "我这边暂时没读到前台应用。";
  }

  const bundleIdText = systemInfo.foregroundApp.bundleId
    ? `，bundle ID 是 ${systemInfo.foregroundApp.bundleId}`
    : "";
  return `前台应用是 ${systemInfo.foregroundApp.name}${bundleIdText}。`;
};

const formatBatteryText = (systemInfo: ZhuochongSystemInfo) => {
  if (!systemInfo.battery) {
    return "我这边暂时没读到电池状态。";
  }

  return `当前电量 ${systemInfo.battery.level}%，${
    systemInfo.battery.isCharging ? "正在充电" : "没有在充电"
  }。`;
};

const formatVolumeText = (systemInfo: ZhuochongSystemInfo) => {
  if (systemInfo.muted) {
    return `系统音量 ${systemInfo.volume}%，当前已静音。`;
  }

  return `系统音量 ${systemInfo.volume}%，当前未静音。`;
};

export const matchLocalSkill = (
  text: string,
): LocalSkillRequest | null => {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return null;
  }

  const productivityRequest = matchProductivitySkill(trimmedText);
  if (productivityRequest) {
    return productivityRequest;
  }

  const reminderHistoryRequest = matchReminderHistorySkill(trimmedText);
  if (reminderHistoryRequest) {
    return reminderHistoryRequest;
  }

  const reminderRuntimeRequest = matchReminderRuntimeSkill(trimmedText);
  if (reminderRuntimeRequest) {
    return reminderRuntimeRequest;
  }

  const manualReminderRequest = matchManualReminderSkill(trimmedText);
  if (manualReminderRequest) {
    return manualReminderRequest;
  }

  const wantsOverview = matchesPattern(trimmedText, [...overviewQueryPatterns]);
  const wantsTime =
    wantsOverview || matchesPattern(trimmedText, [...timeQueryPatterns]);
  const wantsForegroundApp =
    wantsOverview ||
    matchesPattern(trimmedText, [...foregroundAppQueryPatterns]);
  const wantsBattery =
    wantsOverview || matchesPattern(trimmedText, [...batteryQueryPatterns]);
  const wantsVolume =
    wantsOverview || matchesPattern(trimmedText, [...volumeQueryPatterns]);

  if (!wantsTime && !wantsForegroundApp && !wantsBattery && !wantsVolume) {
    return null;
  }

  return {
    skillId: "system_info",
    wantsTime,
    wantsForegroundApp,
    wantsBattery,
    wantsVolume,
  };
};

export const runLocalSkill = async (
  request: LocalSkillRequest,
): Promise<LocalSkillExecutionResult> => {
  if (request.skillId === "productivity_info") {
    const snapshot = await window.zhuochong?.desktop.getProductivitySnapshot?.({
      scope: request.scope,
      includeEvents: false,
      includeReminders: true,
      limit: request.maxItems,
    });

    if (!snapshot) {
      throw new Error("我这边暂时拿不到系统提醒事项。");
    }

    if (!snapshot.availability.reminders) {
      return {
        replyText: getProductivitySourceErrorText(snapshot),
        statusText: "系统提醒事项暂不可用。",
      };
    }

    return {
      replyText: formatProductivitySection(
        snapshot.scope === "today"
          ? "今天的待办"
          : snapshot.scope === "tomorrow"
            ? "明天的待办"
            : "接下来的待办",
        snapshot.reminders.map(
          (item) =>
            `${formatReminderDueTime(item, snapshot.scope)} ${item.title}（${item.listName}）`,
        ),
        snapshot.scope === "today"
          ? "今天没有查到待办。"
          : snapshot.scope === "tomorrow"
            ? "明天没有查到待办。"
            : "接下来没有查到待办。",
      ),
      statusText: "已通过本机系统提醒事项完成查询。",
    };
  }

  if (request.skillId === "reminder_runtime") {
    const runtimeStatus = await desktopLocalService.getReminderRuntimeStatus();
    const parts: string[] = [];

    if (request.wantsOverview) {
      parts.push(formatReminderRuntimeOverview(runtimeStatus));
    }

    if (request.wantsSilentReasons) {
      parts.push(formatReminderSilentReasonStatus(runtimeStatus));
    }

    if (request.wantsFocusMode) {
      parts.push(formatReminderFocusModeStatus(runtimeStatus));
    }

    return {
      replyText: parts.join(" "),
      statusText: "已通过本地运行状态完成查询。",
    };
  }

  if (request.skillId === "reminder_history") {
    const reminderList = await desktopLocalService.getReminderList({
      limit: request.limit,
    });

    return {
      replyText: formatReminderHistory(reminderList.reminders),
      statusText: "已通过本地提醒记录完成查询。",
    };
  }

  if (request.skillId !== "system_info") {
    throw new Error("未支持的本地技能请求。");
  }

  const systemInfo = await window.zhuochong?.desktop.getSystemInfo();
  if (!systemInfo) {
    throw new Error("我这边暂时拿不到系统信息。");
  }

  const parts: string[] = [];

  if (request.wantsTime) {
    parts.push(`现在是 ${systemInfo.currentTime}。`);
  }

  if (request.wantsForegroundApp) {
    parts.push(formatForegroundAppText(systemInfo));
  }

  if (request.wantsBattery) {
    parts.push(formatBatteryText(systemInfo));
  }

  if (request.wantsVolume) {
    parts.push(formatVolumeText(systemInfo));
  }

  return {
    replyText: parts.join(" "),
    statusText: "已通过本机系统查询完成回复。",
  };
};
