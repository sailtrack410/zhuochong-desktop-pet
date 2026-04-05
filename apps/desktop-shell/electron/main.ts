import { spawn, type ChildProcess } from "node:child_process";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  screen,
  systemPreferences,
} from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

app.setName("桌宠 AI");

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../../../..");
const rendererEntry = join(currentDir, "../renderer/index.html");
const localServiceBaseUrl =
  process.env.LOCAL_SERVICE_BASE_URL ?? "http://127.0.0.1:3765";
const openControlPanelOnLaunch =
  process.env.ZHUOCHONG_VISIBLE_DEBUG_WINDOW === "1";

const panelWindowSize = {
  width: 860,
  height: 760,
} as const;

const petWindowLayouts = {
  compact: {
    width: 180,
    height: 160,
  },
  expanded: {
    width: 180,
    height: 160,
  },
} as const;

const floatWindowSize = {
  width: 260,
  height: 180,
} as const;

type PetWindowLayoutMode = keyof typeof petWindowLayouts;

const petWindowTopOverflowByLayout: Record<PetWindowLayoutMode, number> = {
  compact: 0,
  expanded: 168,
};

type RendererMode = "panel" | "pet" | "float";

type PetWindowPosition = {
  x: number;
  y: number;
};

type LocalServiceQuery = Record<string, string | number | undefined>;
type SystemNotificationPayload = {
  notificationId: string;
  title: string;
  body: string;
};
type DesktopProductivityScope = "today" | "tomorrow" | "upcoming";
type DesktopProductivityQuery = {
  scope: DesktopProductivityScope;
  includeEvents: boolean;
  includeReminders: boolean;
  limit?: number;
};
type DesktopCalendarEvent = {
  title: string;
  calendarName: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  location?: string | null;
};
type DesktopCalendarSource = {
  index: number;
  name: string;
};
type DesktopReminderItem = {
  title: string;
  listName: string;
  dueAt?: string;
  completed: boolean;
};
type DesktopProductivitySnapshot = {
  queriedAt: string;
  scope: DesktopProductivityScope;
  events: DesktopCalendarEvent[];
  reminders: DesktopReminderItem[];
  availability: {
    calendar: boolean;
    reminders: boolean;
  };
  errors: {
    calendar?: string;
    reminders?: string;
  };
};
type RuntimeDetectionState = {
  available: boolean;
  value: boolean;
};
type FocusModeNotificationCenter = "distributed" | "local" | "workspace";
type FocusModeNotificationSnapshot = {
  center: FocusModeNotificationCenter;
  event: string;
  object: string | null;
  userInfo: Record<string, unknown>;
  observedAt: string;
  extractedValue: boolean | null;
};
type RawNotificationSnapshot = {
  center: FocusModeNotificationCenter;
  event: string;
  object: string | null;
  observedAt: string;
};

let petWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let controlWindow: BrowserWindow | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let localServiceProcess: ChildProcess | null = null;
let statusItem: Tray | null = null;
let petWindowLayoutMode: PetWindowLayoutMode = "compact";
let petWindowMotionTimer: NodeJS.Timeout | null = null;
let petWindowMotionResolver: ((position: PetWindowPosition) => void) | null =
  null;
let desktopRuntimeStateTimer: NodeJS.Timeout | null = null;
let desktopFocusModeState: {
  detection: RuntimeDetectionState;
  checkedAt: string | null;
  source: string | null;
  lastNotification: FocusModeNotificationSnapshot | null;
  rawNotifications: RawNotificationSnapshot[];
} = {
  detection: {
    available: false,
    value: false,
  },
  checkedAt: null,
  source: null,
  lastNotification: null,
  rawNotifications: [],
};
let focusModeNotificationSubscriptionIds: Array<{
  center: FocusModeNotificationCenter;
  id: number;
}> = [];

const focusModeCandidateNotifications = [
  "com.apple.controlcenter.focusmodes",
  "com.apple.controlcenter.dnd",
  "com.apple.notificationcenter.dnd",
  "com.apple.notificationcenter.pushdnd",
  "com.apple.menuextra.focusmode",
] as const;
const focusModeSignalKeywords = [
  "donotdisturb",
  ".dnd",
  "focusmode",
  "focusmodes",
  "notificationcenterui",
] as const;
const maxRawNotificationSnapshots = 60;
const maxShownSystemNotificationIds = 200;
const shownSystemNotificationIds = new Set<string>();
const defaultProductivityQueryLimit = 5;
const productivityUpcomingHorizonDays = 14;
const macosCalendarAppPath = "/System/Applications/Calendar.app";
const macosRemindersAppPath = "/System/Applications/Reminders.app";

const getLocalServiceEntry = () =>
  app.isPackaged
    ? resolve(
        process.resourcesPath,
        "local-service/dist/apps/local-service/src/main.js",
      )
    : resolve(repoRoot, "apps/local-service/dist/apps/local-service/src/main.js");

const getRuntimeWorkingDirectory = () =>
  app.isPackaged ? process.resourcesPath : repoRoot;

const getDockIconPath = () =>
  app.isPackaged
    ? resolve(process.resourcesPath, "icons/mac/dock-icon.png")
    : resolve(
        repoRoot,
        "apps/desktop-shell/build-resources/mac/dock-icon.png",
      );

const getTrayIconPath = () =>
  app.isPackaged
    ? resolve(process.resourcesPath, "icons/mac/status-icon.png")
    : resolve(
        repoRoot,
        "apps/desktop-shell/build-resources/mac/status-icon.png",
      );

const getWindowStateFilePath = () =>
  join(app.getPath("userData"), "pet-window-state.json");

const getDesktopRuntimeStateFilePath = () =>
  process.env.ZHUOCHONG_RUNTIME_STATE_FILE ??
  join(tmpdir(), "zhuochong-desktop-runtime-state.json");

const createAppIcon = () => {
  const iconPath = getTrayIconPath();
  if (!existsSync(iconPath)) {
    return nativeImage.createEmpty();
  }

  const image = nativeImage
    .createFromPath(iconPath)
    .resize({ width: 18, height: 18 });
  return image.isEmpty() ? nativeImage.createEmpty() : image;
};

const createDockIcon = () => {
  const iconPath = getDockIconPath();
  if (!existsSync(iconPath)) {
    return nativeImage.createEmpty();
  }

  return nativeImage.createFromPath(iconPath);
};

const runCommand = (
  command: string,
  args: string[],
  timeoutMs = 1_500,
): Promise<string> =>
  runCommandWithEnv(command, args, {
    timeoutMs,
  });

const runCommandWithEnv = (
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options?.env ?? process.env,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, options?.timeoutMs ?? 1_500);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });

const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
};

const startOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

const clampProductivityLimit = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultProductivityQueryLimit;
  }

  return Math.min(12, Math.max(1, Math.round(value)));
};

const normalizeIsoString = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsedAt = Date.parse(value);
  if (!Number.isFinite(parsedAt)) {
    return null;
  }

  return new Date(parsedAt).toISOString();
};

const normalizeProductivityQuery = (
  value: unknown,
): DesktopProductivityQuery => {
  const scope =
    isPlainObject(value) &&
    (value.scope === "today" ||
      value.scope === "tomorrow" ||
      value.scope === "upcoming")
      ? value.scope
      : "upcoming";
  const includeEvents =
    isPlainObject(value) && typeof value.includeEvents === "boolean"
      ? value.includeEvents
      : true;
  const includeReminders =
    isPlainObject(value) && typeof value.includeReminders === "boolean"
      ? value.includeReminders
      : true;
  const limit = clampProductivityLimit(
    isPlainObject(value) ? value.limit : undefined,
  );

  return {
    scope,
    includeEvents,
    includeReminders,
    limit,
  };
};

const getProductivityRange = (scope: DesktopProductivityScope) => {
  const now = new Date();
  const todayStart = startOfDay(now);

  if (scope === "today") {
    return {
      now,
      start: todayStart,
      end: addDays(todayStart, 1),
    };
  }

  if (scope === "tomorrow") {
    const start = addDays(todayStart, 1);
    return {
      now,
      start,
      end: addDays(start, 1),
    };
  }

  return {
    now,
    start: now,
    end: addDays(todayStart, productivityUpcomingHorizonDays),
  };
};

const runJxaJsonScript = async <T>(
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 4_000,
): Promise<T> => {
  const output = await runCommandWithEnv(
    "osascript",
    ["-l", "JavaScript", "-e", script],
    {
      timeoutMs,
      env: {
        ...process.env,
        ...env,
      },
    },
  );
  const normalizedOutput = output.trim();
  if (!normalizedOutput) {
    throw new Error("empty JXA output");
  }

  try {
    return JSON.parse(normalizedOutput) as T;
  } catch {
    throw new Error(`invalid JXA JSON output: ${normalizedOutput}`);
  }
};

const normalizeCalendarEvent = (value: unknown): DesktopCalendarEvent | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : "未命名日程";
  const calendarName =
    typeof value.calendarName === "string" && value.calendarName.trim()
      ? value.calendarName.trim()
      : "日历";
  const startAt = normalizeIsoString(value.startAt);
  const endAt = normalizeIsoString(value.endAt);

  if (!startAt || !endAt || typeof value.isAllDay !== "boolean") {
    return null;
  }

  const event: DesktopCalendarEvent = {
    title,
    calendarName,
    startAt,
    endAt,
    isAllDay: value.isAllDay,
  };

  if (typeof value.location === "string") {
    event.location = value.location;
  } else if (value.location === null) {
    event.location = null;
  }

  return event;
};

const normalizeCalendarSource = (value: unknown): DesktopCalendarSource | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  if (
    typeof value.index !== "number" ||
    !Number.isFinite(value.index) ||
    typeof value.name !== "string" ||
    !value.name.trim()
  ) {
    return null;
  }

  return {
    index: Math.max(0, Math.round(value.index)),
    name: value.name.trim(),
  };
};

const normalizeReminderItem = (value: unknown): DesktopReminderItem | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : "未命名待办";
  const listName =
    typeof value.listName === "string" && value.listName.trim()
      ? value.listName.trim()
      : "提醒";

  if (typeof value.completed !== "boolean") {
    return null;
  }

  const item: DesktopReminderItem = {
    title,
    listName,
    completed: value.completed,
  };

  const dueAt = normalizeIsoString(value.dueAt);
  if (dueAt) {
    item.dueAt = dueAt;
  }

  return item;
};

const getProductivityErrorMessage = (
  source: "calendar" | "reminders",
  error: unknown,
) => {
  const rawMessage =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  const normalizedMessage = rawMessage.toLowerCase();

  if (
    normalizedMessage.includes("not authorized") ||
    normalizedMessage.includes("not permitted") ||
    normalizedMessage.includes("automation") ||
    normalizedMessage.includes("permission") ||
    normalizedMessage.includes("1743")
  ) {
    return source === "calendar"
      ? "系统日历还没有授权给桌宠 AI。"
      : "系统提醒事项还没有授权给桌宠 AI。";
  }

  return source === "calendar"
    ? "系统日历暂时不可用。"
    : "系统提醒事项暂时不可用。";
};

const queryCalendarEvents = async (
  query: DesktopProductivityQuery,
): Promise<DesktopCalendarEvent[]> => {
  const range = getProductivityRange(query.scope);
  const limit = clampProductivityLimit(query.limit);

  const calendarSourcesRaw = await runJxaJsonScript<unknown[]>(
    `
      (function () {
        ObjC.import("stdlib");
        ObjC.import("Foundation");

        function writeJsonResult(value) {
          var text = JSON.stringify(value);
          var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
          $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
        }

        var app = Application($.getenv("ZC_APP_PATH"));
        var calendars = app.calendars();
        var result = [];

        for (var index = 0; index < calendars.length; index += 1) {
          var calendar = calendars[index];
          try {
            result.push({
              index: index,
              name: String(calendar.name())
            });
          } catch (_error) {
            result.push({
              index: index,
              name: "日历 " + index
            });
          }
        }

        writeJsonResult(result);
      })();
    `,
    {
      ZC_APP_PATH: macosCalendarAppPath,
    },
    8_000,
  );

  const calendarSources = Array.isArray(calendarSourcesRaw)
    ? calendarSourcesRaw
        .map((item) => normalizeCalendarSource(item))
        .filter((item): item is DesktopCalendarSource => item !== null)
    : [];

  const querySingleCalendar = async (source: DesktopCalendarSource) =>
    runJxaJsonScript<unknown[]>(
    `
      (function () {
        ObjC.import("stdlib");
        ObjC.import("Foundation");

        function writeJsonResult(value) {
          var text = JSON.stringify(value);
          var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
          $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
        }

        function safeCall(fn, fallbackValue) {
          try {
            return fn();
          } catch (_error) {
            return fallbackValue;
          }
        }

        var app = Application($.getenv("ZC_APP_PATH"));
        var calendarIndex = Number($.getenv("ZC_CALENDAR_INDEX") || "0");
        var start = new Date($.getenv("ZC_START_ISO"));
        var end = new Date($.getenv("ZC_END_ISO"));
        var calendars = app.calendars();
        var calendar = calendars[calendarIndex];
        var events = [];

        if (!calendar) {
          writeJsonResult(events);
          return;
        }

        var calendarName = safeCall(function () {
          return String(calendar.name());
        }, "日历");
        var calendarEvents = safeCall(function () {
          return calendar.events.whose({
            startDate: { _lessThan: end },
            endDate: { _greaterThanEquals: start }
          })();
        }, []);

        for (var eventIndex = 0; eventIndex < calendarEvents.length; eventIndex += 1) {
          var event = calendarEvents[eventIndex];
          var startDate = safeCall(function () {
            return event.startDate();
          }, null);
          var endDate = safeCall(function () {
            return event.endDate();
          }, null);

          if (!startDate || !endDate) {
            continue;
          }

          var payload = {
            title: safeCall(function () {
              return String(event.summary());
            }, "未命名日程"),
            calendarName: calendarName || "日历",
            startAt: startDate.toISOString(),
            endAt: endDate.toISOString(),
            isAllDay: Boolean(
              safeCall(function () {
                if (typeof event.alldayEvent === "function") {
                  return event.alldayEvent();
                }
                return event.allDayEvent();
              }, false)
            )
          };

          var location = safeCall(function () {
            var nextLocation = event.location();
            return nextLocation ? String(nextLocation) : null;
          }, null);
          if (location !== null) {
            payload.location = location;
          }

          events.push(payload);
        }

        events.sort(function (left, right) {
          var startDiff = new Date(left.startAt).getTime() - new Date(right.startAt).getTime();
          if (startDiff !== 0) {
            return startDiff;
          }

          return new Date(left.endAt).getTime() - new Date(right.endAt).getTime();
        });

        writeJsonResult(events);
      })();
    `,
    {
      ZC_APP_PATH: macosCalendarAppPath,
      ZC_CALENDAR_INDEX: String(source.index),
      ZC_START_ISO: range.start.toISOString(),
      ZC_END_ISO: range.end.toISOString(),
    },
    4_000,
  );

  const collectedEvents: DesktopCalendarEvent[] = [];

  for (const source of calendarSources) {
    try {
      const rawEvents = await querySingleCalendar(source);
      if (!Array.isArray(rawEvents)) {
        continue;
      }

      const normalizedEvents = rawEvents
        .map((item) => normalizeCalendarEvent(item))
        .filter((item): item is DesktopCalendarEvent => item !== null);
      collectedEvents.push(...normalizedEvents);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[productivity] skip calendar source ${source.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return collectedEvents
    .sort((left, right) => {
      const startDiff =
        Date.parse(left.startAt) - Date.parse(right.startAt);
      if (startDiff !== 0) {
        return startDiff;
      }

      return Date.parse(left.endAt) - Date.parse(right.endAt);
    })
    .slice(0, limit);
};

const compareReminderItems = (
  left: DesktopReminderItem,
  right: DesktopReminderItem,
) => {
  const leftDueAt = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
  const rightDueAt = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;

  if (leftDueAt !== rightDueAt) {
    return leftDueAt - rightDueAt;
  }

  return left.title.localeCompare(right.title, "zh-CN");
};

const queryReminderItems = async (
  query: DesktopProductivityQuery,
): Promise<DesktopReminderItem[]> => {
  const rawItems = await runJxaJsonScript<unknown[]>(
    `
      (function () {
        ObjC.import("stdlib");
        ObjC.import("Foundation");

        function writeJsonResult(value) {
          var text = JSON.stringify(value);
          var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
          $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
        }

        function safeCall(fn, fallbackValue) {
          try {
            return fn();
          } catch (_error) {
            return fallbackValue;
          }
        }

        var app = Application($.getenv("ZC_APP_PATH"));
        var lists = app.lists();
        var reminders = [];

        for (var listIndex = 0; listIndex < lists.length; listIndex += 1) {
          var list = lists[listIndex];
          var listName = safeCall(function () {
            return String(list.name());
          }, "提醒");
          var items = safeCall(function () {
            return list.reminders.whose({
              completed: false
            })();
          }, []);

          for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            var item = items[itemIndex];
            var payload = {
              title: safeCall(function () {
                return String(item.name());
              }, "未命名待办"),
              listName: listName || "提醒",
              completed: false
            };
            var dueDate = safeCall(function () {
              return item.dueDate();
            }, null);
            if (dueDate) {
              payload.dueAt = dueDate.toISOString();
            }
            reminders.push(payload);
          }
        }

        writeJsonResult(reminders);
      })();
    `,
    {
      ZC_APP_PATH: macosRemindersAppPath,
    },
    12_000,
  );

  if (!Array.isArray(rawItems)) {
    return [];
  }

  const range = getProductivityRange(query.scope);
  const normalizedItems = rawItems
    .map((item) => normalizeReminderItem(item))
    .filter((item): item is DesktopReminderItem => item !== null)
    .filter((item) => item.completed === false);

  if (query.scope === "today" || query.scope === "tomorrow") {
    return normalizedItems
      .filter((item) => {
        if (!item.dueAt) {
          return false;
        }

        const dueAt = Date.parse(item.dueAt);
        return dueAt >= range.start.getTime() && dueAt < range.end.getTime();
      })
      .sort(compareReminderItems)
      .slice(0, clampProductivityLimit(query.limit));
  }

  return normalizedItems
    .sort(compareReminderItems)
    .slice(0, clampProductivityLimit(query.limit));
};

const getProductivitySnapshot = async (
  query: DesktopProductivityQuery,
): Promise<DesktopProductivitySnapshot> => {
  const snapshot: DesktopProductivitySnapshot = {
    queriedAt: new Date().toISOString(),
    scope: query.scope,
    events: [],
    reminders: [],
    availability: {
      calendar: process.platform === "darwin",
      reminders: process.platform === "darwin",
    },
    errors: {},
  };

  if (process.platform !== "darwin") {
    snapshot.availability.calendar = false;
    snapshot.availability.reminders = false;
    if (query.includeEvents) {
      snapshot.errors.calendar = "当前版本只支持 macOS 系统日历。";
    }
    if (query.includeReminders) {
      snapshot.errors.reminders = "当前版本只支持 macOS 系统提醒事项。";
    }
    return snapshot;
  }

  if (query.includeEvents) {
    try {
      snapshot.events = await queryCalendarEvents(query);
    } catch (error) {
      snapshot.availability.calendar = false;
      snapshot.errors.calendar = getProductivityErrorMessage("calendar", error);
    }
  }

  if (query.includeReminders) {
    try {
      snapshot.reminders = await queryReminderItems(query);
    } catch (error) {
      snapshot.availability.reminders = false;
      snapshot.errors.reminders = getProductivityErrorMessage("reminders", error);
    }
  }

  return snapshot;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeNotificationValue = (value: unknown, depth = 0): unknown => {
  if (depth >= 4) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item) => normalizeNotificationValue(item, depth + 1));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [key, normalizeNotificationValue(item, depth + 1)]),
    );
  }

  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
};

const parseBooleanLike = (value: unknown): boolean | null => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "enabled", "active"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "off", "disabled", "inactive"].includes(normalized)) {
    return false;
  }

  return null;
};

const extractBooleanFromNotificationPayload = (
  value: unknown,
  depth = 0,
): boolean | null => {
  if (depth >= 5) {
    return null;
  }

  const directValue = parseBooleanLike(value);
  if (directValue !== null) {
    return directValue;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedValue = extractBooleanFromNotificationPayload(item, depth + 1);
      if (nestedValue !== null) {
        return nestedValue;
      }
    }

    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const priorityKeys = [
    "isOn",
    "isActive",
    "active",
    "enabled",
    "value",
    "state",
    "doNotDisturbEnabled",
    "focusModeEnabled",
    "suppressed",
    "willSuppressInterruptions",
  ];

  for (const key of priorityKeys) {
    if (!(key in value)) {
      continue;
    }

    const nestedValue = extractBooleanFromNotificationPayload(
      value[key],
      depth + 1,
    );
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const parsedValue = extractBooleanFromNotificationPayload(
      nestedValue,
      depth + 1,
    );
    if (parsedValue !== null) {
      return parsedValue;
    }
  }

  return null;
};

const isInterestingFocusModeSignal = (params: {
  event: string;
  object: string;
  userInfo: Record<string, unknown>;
}) => {
  const haystack = JSON.stringify({
    event: params.event,
    object: params.object,
    userInfo: normalizeNotificationValue(params.userInfo),
  }).toLowerCase();

  return focusModeSignalKeywords.some((keyword) => haystack.includes(keyword));
};

const appendRawFocusModeNotification = (params: {
  center: FocusModeNotificationCenter;
  event: string;
  object: string;
}) => {
  desktopFocusModeState = {
    ...desktopFocusModeState,
    rawNotifications: [
      ...desktopFocusModeState.rawNotifications.slice(
        -(maxRawNotificationSnapshots - 1),
      ),
      {
        center: params.center,
        event: params.event,
        object: params.object || null,
        observedAt: new Date().toISOString(),
      },
    ],
  };
};

const applyFocusModeNotificationObservation = (params: {
  center: FocusModeNotificationCenter;
  event: string;
  userInfo: Record<string, unknown>;
  object: string;
}) => {
  const observedAt = new Date().toISOString();
  const normalizedUserInfo = normalizeNotificationValue(
    params.userInfo,
  ) as Record<string, unknown>;
  const extractedValue = extractBooleanFromNotificationPayload({
    object: params.object,
    userInfo: normalizedUserInfo,
  });

  desktopFocusModeState = {
    detection: extractedValue === null
      ? desktopFocusModeState.detection
      : {
          available: true,
          value: extractedValue,
        },
    checkedAt: observedAt,
    source:
      extractedValue === null
        ? desktopFocusModeState.source
        : `${params.center}:${params.event}`,
    lastNotification: {
      center: params.center,
        event: params.event,
        object: params.object || null,
        userInfo: normalizedUserInfo,
        observedAt,
        extractedValue,
      },
    rawNotifications: desktopFocusModeState.rawNotifications,
  };

  // eslint-disable-next-line no-console
  console.log(
    `[focus-mode] ${params.center} notification ${params.event} extracted=${
      extractedValue === null ? "unknown" : extractedValue ? "true" : "false"
    }`,
  );
};

const registerFocusModeNotificationObservers = () => {
  if (process.platform !== "darwin" || focusModeNotificationSubscriptionIds.length > 0) {
    return;
  }

  const subscribe = (
    center: FocusModeNotificationCenter,
    event: string | null,
  ): number => {
    if (center === "distributed") {
      return systemPreferences.subscribeNotification(
        event,
        (receivedEvent, userInfo, object) => {
          appendRawFocusModeNotification({
            center,
            event: receivedEvent,
            object,
          });
          if (
            event === null &&
            !isInterestingFocusModeSignal({
              event: receivedEvent,
              object,
              userInfo,
            })
          ) {
            return;
          }

          applyFocusModeNotificationObservation({
            center,
            event: receivedEvent,
            userInfo,
            object,
          });
        },
      );
    }

    if (center === "workspace") {
      return systemPreferences.subscribeWorkspaceNotification(
        event,
        (receivedEvent, userInfo, object) => {
          appendRawFocusModeNotification({
            center,
            event: receivedEvent,
            object,
          });
          if (
            event === null &&
            !isInterestingFocusModeSignal({
              event: receivedEvent,
              object,
              userInfo,
            })
          ) {
            return;
          }

          applyFocusModeNotificationObservation({
            center,
            event: receivedEvent,
            userInfo,
            object,
          });
        },
      );
    }

    return systemPreferences.subscribeLocalNotification(
      event,
      (receivedEvent, userInfo, object) => {
        appendRawFocusModeNotification({
          center,
          event: receivedEvent,
          object,
        });
        if (
          event === null &&
          !isInterestingFocusModeSignal({
            event: receivedEvent,
            object,
            userInfo,
          })
        ) {
          return;
        }

        applyFocusModeNotificationObservation({
          center,
          event: receivedEvent,
          userInfo,
          object,
        });
      },
    );
  };

  for (const event of focusModeCandidateNotifications) {
    for (const center of ["distributed", "local", "workspace"] as const) {
      try {
        const id = subscribe(center, event);
        focusModeNotificationSubscriptionIds.push({
          center,
          id,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          `[focus-mode] subscribe failed (${center}:${event}): ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
  }

};

const unregisterFocusModeNotificationObservers = () => {
  for (const subscription of focusModeNotificationSubscriptionIds) {
    try {
      if (subscription.center === "distributed") {
        systemPreferences.unsubscribeNotification(subscription.id);
      } else if (subscription.center === "workspace") {
        systemPreferences.unsubscribeWorkspaceNotification(subscription.id);
      } else {
        systemPreferences.unsubscribeLocalNotification(subscription.id);
      }
    } catch {
      // Ignore cleanup failures during shutdown.
    }
  }

  focusModeNotificationSubscriptionIds = [];
};

const detectFrontmostFullscreen = async (): Promise<{
  available: boolean;
  value: boolean;
}> => {
  if (process.platform !== "darwin") {
    return {
      available: false,
      value: false,
    };
  }

  const accessibilityTrusted =
    systemPreferences.isTrustedAccessibilityClient(false);
  if (!accessibilityTrusted) {
    return {
      available: false,
      value: false,
    };
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
      available: true,
      value: output.trim().toLowerCase() === "true",
    };
  } catch {
    return {
      available: false,
      value: false,
    };
  }
};

const detectFocusModeEnabled = async (): Promise<RuntimeDetectionState> => {
  if (process.env.ZHUOCHONG_FORCE_FOCUS_MODE === "1") {
    return {
      available: true,
      value: true,
    };
  }

  if (process.platform !== "darwin") {
    return {
      available: false,
      value: false,
    };
  }

  try {
    const output = await runCommand("defaults", [
      "read",
      "com.apple.controlcenter",
      "NSStatusItem VisibleCC FocusModes",
    ]);
    const parsedValue = parseBooleanLike(output);
    return {
      available: true,
      value: parsedValue === true,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("does not exist")) {
      return {
        available: true,
        value: false,
      };
    }

    if (desktopFocusModeState.detection.available) {
      return desktopFocusModeState.detection;
    }

    return {
      available: false,
      value: false,
    };
  }
};

const writeDesktopRuntimeState = async () => {
  let fullscreen: RuntimeDetectionState = {
    available: false,
    value: false,
  };
  let focusMode = desktopFocusModeState.detection;

  try {
    fullscreen = await detectFrontmostFullscreen();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[desktop-runtime-state] fullscreen detect failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  try {
    focusMode = await detectFocusModeEnabled();
    desktopFocusModeState = {
      ...desktopFocusModeState,
      detection: focusMode,
      checkedAt: new Date().toISOString(),
      source: focusMode.available
        ? "defaults:com.apple.controlcenter:NSStatusItem VisibleCC FocusModes"
        : desktopFocusModeState.source,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[desktop-runtime-state] focus detect failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  try {
    writeFileSync(
      getDesktopRuntimeStateFilePath(),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          fullscreen,
          focusMode,
          focusModeDebug: {
            checkedAt: desktopFocusModeState.checkedAt,
            source: desktopFocusModeState.source,
            lastNotification: desktopFocusModeState.lastNotification,
            rawNotifications: desktopFocusModeState.rawNotifications,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[desktop-runtime-state] write failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
};

const startDesktopRuntimeStateSync = () => {
  if (desktopRuntimeStateTimer) {
    return;
  }

  registerFocusModeNotificationObservers();
  void writeDesktopRuntimeState();
  desktopRuntimeStateTimer = setInterval(() => {
    void writeDesktopRuntimeState();
  }, 5_000);
};

const stopDesktopRuntimeStateSync = () => {
  if (!desktopRuntimeStateTimer) {
    return;
  }

  clearInterval(desktopRuntimeStateTimer);
  desktopRuntimeStateTimer = null;
  unregisterFocusModeNotificationObservers();
};

const writeSavedPosition = (position: PetWindowPosition) => {
  const filePath = getWindowStateFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(position, null, 2), "utf8");
};

const getPetWindowSize = (layoutMode: PetWindowLayoutMode) =>
  petWindowLayouts[layoutMode];

const getWindowPosition = (window: BrowserWindow): PetWindowPosition => {
  const [x, y] = window.getPosition();
  return {
    x: x ?? 0,
    y: y ?? 0,
  };
};

const clampPosition = (
  position: PetWindowPosition,
  options?: {
    layoutMode?: PetWindowLayoutMode;
    size?: {
      width: number;
      height: number;
    };
  },
): PetWindowPosition => {
  const workArea = screen.getPrimaryDisplay().workArea;
  const layoutMode = options?.layoutMode ?? petWindowLayoutMode;
  const size = options?.size ?? getPetWindowSize(layoutMode);

  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  const minY = workArea.y - petWindowTopOverflowByLayout[layoutMode];

  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, minY), maxY),
  };
};

const stopPetWindowMotion = (window?: BrowserWindow) => {
  if (petWindowMotionTimer) {
    clearTimeout(petWindowMotionTimer);
    petWindowMotionTimer = null;
  }

  if (petWindowMotionResolver) {
    const resolve = petWindowMotionResolver;
    petWindowMotionResolver = null;
    resolve(
      window && !window.isDestroyed()
        ? getWindowPosition(window)
        : getDefaultPosition(),
    );
  }
};

const pickRandomPetWindowTarget = (window: BrowserWindow): PetWindowPosition => {
  const currentPosition = getWindowPosition(window);
  const { width, height } = window.getBounds();
  const size = { width, height };

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nextPosition = clampPosition(
      {
        x: Math.round(currentPosition.x + (Math.random() * 520 - 260)),
        y: Math.round(currentPosition.y + (Math.random() * 220 - 110)),
      },
      {
        size,
      },
    );

    const distance = Math.hypot(
      nextPosition.x - currentPosition.x,
      nextPosition.y - currentPosition.y,
    );
    if (distance >= 96) {
      return nextPosition;
    }
  }

  return clampPosition(
    {
      x: currentPosition.x + 160,
      y: currentPosition.y - 28,
    },
    {
      size,
    },
  );
};

const animatePetWindowTo = (
  window: BrowserWindow,
  targetPosition: PetWindowPosition,
  durationMs = 960,
): Promise<PetWindowPosition> =>
  new Promise((resolve) => {
    stopPetWindowMotion(window);

    const startPosition = getWindowPosition(window);
    const { width, height } = window.getBounds();
    const size = { width, height };

    if (
      startPosition.x === targetPosition.x &&
      startPosition.y === targetPosition.y
    ) {
      resolve(startPosition);
      return;
    }

    const startedAt = Date.now();
    petWindowMotionResolver = resolve;

    const tick = () => {
      if (window.isDestroyed()) {
        stopPetWindowMotion();
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const progress = Math.min(1, elapsedMs / durationMs);
      const easedProgress =
        progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      const nextPosition = clampPosition(
        {
          x: Math.round(
            startPosition.x +
              (targetPosition.x - startPosition.x) * easedProgress,
          ),
          y: Math.round(
            startPosition.y +
              (targetPosition.y - startPosition.y) * easedProgress,
          ),
        },
        {
          size,
        },
      );

      window.setPosition(nextPosition.x, nextPosition.y);

      if (progress >= 1) {
        if (petWindowMotionTimer) {
          clearTimeout(petWindowMotionTimer);
          petWindowMotionTimer = null;
        }

        const resolveMotion = petWindowMotionResolver;
        petWindowMotionResolver = null;
        window.setPosition(targetPosition.x, targetPosition.y);
        persistWindowPosition(window, {
          immediate: true,
        });
        resolveMotion?.(targetPosition);
        return;
      }

      petWindowMotionTimer = setTimeout(tick, 16);
    };

    tick();
  });

const getDefaultPosition = (): PetWindowPosition => {
  const workArea = screen.getPrimaryDisplay().workArea;
  const size = getPetWindowSize("compact");
  return {
    x: workArea.x + workArea.width - size.width - 52,
    y: workArea.y + workArea.height - size.height - 52,
  };
};

const readSavedPosition = (): PetWindowPosition => {
  const filePath = getWindowStateFilePath();

  if (!existsSync(filePath)) {
    return getDefaultPosition();
  }

  try {
    const parsed = JSON.parse(
      readFileSync(filePath, "utf8"),
    ) as Partial<PetWindowPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
      return getDefaultPosition();
    }

    return clampPosition({
      x: parsed.x,
      y: parsed.y,
    }, {
      layoutMode: "compact",
    });
  } catch {
    return getDefaultPosition();
  }
};

const setPetWindowLayoutMode = (
  window: BrowserWindow,
  layoutMode: PetWindowLayoutMode,
) => {
  const nextSize = getPetWindowSize(layoutMode);
  const currentBounds = window.getBounds();
  const currentWidth = currentBounds.width;
  const currentHeight = currentBounds.height;

  if (
    currentWidth === nextSize.width &&
    currentHeight === nextSize.height &&
    petWindowLayoutMode === layoutMode
  ) {
    return;
  }

  // 窗口中心对齐，切换时桌宠视觉位置不变
  const centerX = currentBounds.x + currentWidth / 2;
  const centerY = currentBounds.y + currentHeight / 2;

  const nextPosition = clampPosition(
    {
      x: Math.round(centerX - nextSize.width / 2),
      y: Math.round(centerY - nextSize.height / 2),
    },
    {
      layoutMode,
      size: nextSize,
    },
  );

  petWindowLayoutMode = layoutMode;
  window.setBounds({
    x: nextPosition.x,
    y: nextPosition.y,
    width: nextSize.width,
    height: nextSize.height,
  });
};

const clearPersistTimer = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
};

const persistWindowPosition = (
  window: BrowserWindow,
  options?: {
    immediate?: boolean;
  },
) => {
  clearPersistTimer();

  const persist = () => {
    if (window.isDestroyed()) {
      return;
    }

    const position = window.getPosition();
    const x = position[0];
    const y = position[1];
    if (x === undefined || y === undefined) {
      return;
    }

    writeSavedPosition(
      clampPosition({
        x,
        y,
      }),
    );
  };

  if (options?.immediate) {
    persist();
    return;
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 120);
};

const getPetWindow = () => {
  if (!petWindow || petWindow.isDestroyed()) {
    throw new Error("Desktop pet window is not available.");
  }

  return petWindow;
};

const syncFloatWindowPosition = () => {
  if (!petWindow || petWindow.isDestroyed() || !floatWindow || floatWindow.isDestroyed()) {
    return;
  }

  const petBounds = petWindow.getBounds();
  const floatBounds = floatWindow.getBounds();
  const workArea = screen.getPrimaryDisplay().workArea;
  const gap = 8;

  // 计算桌宠中心位置
  const petCenterY = petBounds.y + Math.round(petBounds.height / 2);
  const floatCenterY = Math.round(floatBounds.height / 2);

  // 优先放右侧
  let floatX = petBounds.x + petBounds.width + gap;
  let floatY = petCenterY - floatCenterY;

  // 检查右侧空间是否足够
  const rightSpace = workArea.x + workArea.width - (petBounds.x + petBounds.width);

  if (rightSpace < floatBounds.width + gap) {
    // 右侧空间不够，放左侧
    floatX = petBounds.x - floatBounds.width - gap;
  }

  // 确保不超出屏幕上下边界
  floatY = Math.max(workArea.y, Math.min(floatY, workArea.y + workArea.height - floatBounds.height));

  floatWindow.setPosition(floatX, floatY);
};

const showFloatWindow = () => {
  if (!floatWindow || floatWindow.isDestroyed()) {
    return;
  }

  syncFloatWindowPosition();
  floatWindow.show();
};

const hideFloatWindow = () => {
  if (!floatWindow || floatWindow.isDestroyed()) {
    return;
  }

  floatWindow.hide();
};

const logLocalServiceOutput = (
  channel: "stdout" | "stderr",
  chunk: Buffer | string,
) => {
  const message = chunk.toString().trim();
  if (!message) {
    return;
  }

  if (channel === "stdout") {
    // eslint-disable-next-line no-console
    console.log(`[local-service] ${message}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`[local-service] ${message}`);
};

const startManagedLocalService = () => {
  if (process.env.LOCAL_SERVICE_AUTOSTART === "0") {
    return;
  }

  if (localServiceProcess && localServiceProcess.exitCode === null) {
    return;
  }

  const localServiceEntry = getLocalServiceEntry();
  if (!existsSync(localServiceEntry)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[local-service] build output not found at ${localServiceEntry}.`,
    );
    return;
  }

  localServiceProcess = spawn(process.execPath, [localServiceEntry], {
    cwd: getRuntimeWorkingDirectory(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      APP_PORT: process.env.APP_PORT ?? "3765",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  localServiceProcess.stdout?.on("data", (chunk) => {
    logLocalServiceOutput("stdout", chunk);
  });
  localServiceProcess.stderr?.on("data", (chunk) => {
    logLocalServiceOutput("stderr", chunk);
  });
  localServiceProcess.once("exit", (code, signal) => {
    if (code && signal !== "SIGTERM") {
      // eslint-disable-next-line no-console
      console.error(
        `[local-service] exited unexpectedly with code=${code}, signal=${signal ?? "none"}.`,
      );
    }

    localServiceProcess = null;
  });
};

const stopManagedLocalService = () => {
  if (!localServiceProcess || localServiceProcess.exitCode !== null) {
    return;
  }

  localServiceProcess.kill("SIGTERM");
  localServiceProcess = null;
};

const createLocalServiceUrl = (
  pathname: string,
  query?: LocalServiceQuery,
): string => {
  const url = new URL(pathname, `${localServiceBaseUrl}/`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
};

const requestLocalService = async (options: {
  pathname: string;
  method?: "GET" | "POST";
  query?: LocalServiceQuery;
  body?: unknown;
}): Promise<unknown> => {
  const requestInit = {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    cache: "no-store" as const,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  };

  const response = await fetch(
    createLocalServiceUrl(options.pathname, options.query),
    requestInit,
  );

  const responseText = await response.text();
  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(
      `Local service returned non-JSON payload for ${options.pathname}.`,
    );
  }
};

const delay = (ms: number) =>
  new Promise<void>((resolveTimeout) => {
    setTimeout(resolveTimeout, ms);
  });

const waitForLocalServiceReady = async () => {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await requestLocalService({
        pathname: "/health",
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("local-service did not become ready in time.");
};

const loadRenderer = (window: BrowserWindow, mode: RendererMode) => {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    url.searchParams.set("mode", mode);
    void window.loadURL(url.toString());
    return;
  }

  void window.loadFile(rendererEntry, {
    query: {
      mode,
    },
  });
};

const attachWindowDiagnostics = (window: BrowserWindow, label: string) => {
  window.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      // eslint-disable-next-line no-console
      console.log(
        `[desktop-shell:${label}][console:${level}] ${message} (${sourceId}:${line})`,
      );
    },
  );
  window.webContents.on("preload-error", (_event, path, error) => {
    // eslint-disable-next-line no-console
    console.error(
      `[desktop-shell:${label}] preload error at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  window.webContents.on("did-finish-load", () => {
    // eslint-disable-next-line no-console
    console.log(`[desktop-shell:${label}] renderer loaded`);

    void window.webContents
      .executeJavaScript(`
        (() => {
          const root = document.getElementById("root");
          return {
            href: window.location.href,
            title: document.title,
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            rootChildCount: root?.childElementCount ?? -1,
            rootHtmlPreview: root?.innerHTML.slice(0, 320) ?? "",
            hasBridge: Boolean(window.zhuochong),
          };
        })();
      `)
      .then((snapshot) => {
        // eslint-disable-next-line no-console
        console.log(
          `[desktop-shell:${label}] dom snapshot ${JSON.stringify(snapshot)}`,
        );
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[desktop-shell:${label}] dom snapshot failed`, error);
      });
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      // eslint-disable-next-line no-console
      console.error(
        `[desktop-shell:${label}] failed to load renderer: ${errorCode} ${errorDescription} (${validatedUrl})`,
      );
    },
  );
};

const showControlWindow = () => {
  if (!controlWindow || controlWindow.isDestroyed()) {
    controlWindow = createControlWindow();
  }

  if (controlWindow.isMinimized()) {
    controlWindow.restore();
  }

  controlWindow.show();
  controlWindow.focus();
  refreshStatusItemMenu();
  return controlWindow;
};

const hideControlWindow = () => {
  if (!controlWindow || controlWindow.isDestroyed()) {
    return;
  }

  controlWindow.hide();
  refreshStatusItemMenu();
};

const toggleControlWindow = () => {
  if (!controlWindow || controlWindow.isDestroyed()) {
    showControlWindow();
    return;
  }

  if (controlWindow.isVisible()) {
    hideControlWindow();
    return;
  }

  showControlWindow();
};

const showPetWindow = () => {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = createPetWindow();
  }

  if (petWindow.isMinimized()) {
    petWindow.restore();
  }

  petWindow.show();
  petWindow.focus();
  refreshStatusItemMenu();
  return petWindow;
};

const hidePetWindow = () => {
  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }

  petWindow.hide();
  refreshStatusItemMenu();
};

const createStatusItemMenu = () =>
  Menu.buildFromTemplate([
    {
      label:
        petWindow && !petWindow.isDestroyed() && petWindow.isVisible()
          ? "隐藏桌宠"
          : "显示桌宠",
      click: () => {
        if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
          hidePetWindow();
          return;
        }

        showPetWindow();
      },
    },
    {
      label:
        controlWindow &&
        !controlWindow.isDestroyed() &&
        controlWindow.isVisible()
          ? "隐藏控制台"
          : "打开控制台",
      click: () => {
        toggleControlWindow();
      },
    },
    {
      type: "separator",
    },
    {
      label: "退出桌宠",
      click: () => {
        app.quit();
      },
    },
  ]);

function refreshStatusItemMenu() {
  if (!statusItem) {
    return;
  }

  statusItem.setContextMenu(createStatusItemMenu());
}

const rememberShownSystemNotification = (notificationId: string) => {
  shownSystemNotificationIds.add(notificationId);
  if (shownSystemNotificationIds.size <= maxShownSystemNotificationIds) {
    return;
  }

  const oldestNotificationId = shownSystemNotificationIds.values().next().value;
  if (oldestNotificationId) {
    shownSystemNotificationIds.delete(oldestNotificationId);
  }
};

const showSystemNotification = (payload: SystemNotificationPayload) => {
  if (!Notification.isSupported()) {
    return false;
  }

  if (shownSystemNotificationIds.has(payload.notificationId)) {
    return false;
  }

  rememberShownSystemNotification(payload.notificationId);

  try {
    const icon = createDockIcon();
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      ...(icon.isEmpty() ? {} : { icon }),
    });

    notification.on("click", () => {
      if (process.platform === "darwin") {
        app.focus();
      }

      showControlWindow();
    });

    notification.show();
    return true;
  } catch (error) {
    shownSystemNotificationIds.delete(payload.notificationId);
    // eslint-disable-next-line no-console
    console.warn(
      `[desktop-shell] failed to show system notification: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
};

const showPetContextMenu = () => {
  const window = getPetWindow();
  Menu.buildFromTemplate([
    {
      label: "打开控制台",
      click: () => {
        showControlWindow();
      },
    },
    {
      label: "隐藏桌宠",
      click: () => {
        hidePetWindow();
      },
    },
    {
      type: "separator",
    },
    {
      label: "退出桌宠",
      click: () => {
        app.quit();
      },
    },
  ]).popup({
    window,
  });
};

const createStatusItem = () => {
  if (statusItem) {
    return statusItem;
  }

  const icon = createAppIcon();
  statusItem = new Tray(icon);
  statusItem.setToolTip("桌宠 AI");
  refreshStatusItemMenu();
  statusItem.on("click", () => {
    toggleControlWindow();
  });
  statusItem.on("right-click", () => {
    refreshStatusItemMenu();
    statusItem?.popUpContextMenu();
  });

  return statusItem;
};

const configureMacApplicationShell = () => {
  if (process.platform !== "darwin") {
    return;
  }

  app.setActivationPolicy("regular");
  app.dock.show();

  const icon = createDockIcon();
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "桌宠 AI",
        submenu: [
          {
            label: "打开控制台",
            click: () => {
              showControlWindow();
            },
          },
          {
            label: "显示桌宠",
            click: () => {
              showPetWindow();
            },
          },
          {
            type: "separator",
          },
          {
            role: "quit",
            label: "退出桌宠",
          },
        ],
      },
      {
        label: "编辑",
        submenu: [
          {
            role: "undo",
            label: "撤销",
          },
          {
            role: "redo",
            label: "重做",
          },
          {
            type: "separator",
          },
          {
            role: "cut",
            label: "剪切",
          },
          {
            role: "copy",
            label: "复制",
          },
          {
            role: "paste",
            label: "粘贴",
          },
          {
            role: "selectAll",
            label: "全选",
          },
        ],
      },
    ]),
  );
};

const registerIpcHandlers = () => {
  ipcMain.handle("runtime:get-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle("pet-window:get-position", () => {
    const window = getPetWindow();
    return getWindowPosition(window);
  });

  ipcMain.handle(
    "pet-window:move-to",
    (_event, position: PetWindowPosition): PetWindowPosition => {
      const window = getPetWindow();
      stopPetWindowMotion(window);
      const nextPosition = clampPosition(position);
      window.setPosition(nextPosition.x, nextPosition.y);
      persistWindowPosition(window);
      return nextPosition;
    },
  );

  ipcMain.handle(
    "pet-window:animate-to",
    (_event, position: PetWindowPosition, durationMs?: number) => {
      const window = getPetWindow();
      const targetPosition = clampPosition(position);
      const nextDurationMs =
        typeof durationMs === "number" && Number.isFinite(durationMs)
          ? Math.max(240, Math.round(durationMs))
          : undefined;
      return animatePetWindowTo(window, targetPosition, nextDurationMs);
    },
  );

  ipcMain.handle("pet-window:move-randomly", async () => {
    const window = getPetWindow();
    const targetPosition = pickRandomPetWindowTarget(window);
    return animatePetWindowTo(window, targetPosition);
  });

  ipcMain.handle("pet-window:cancel-motion", () => {
    const window = petWindow && !petWindow.isDestroyed() ? petWindow : undefined;
    stopPetWindowMotion(window ?? undefined);
    return true;
  });

  ipcMain.handle(
    "pet-window:set-layout-mode",
    (_event, layoutMode: PetWindowLayoutMode) => {
      const window = getPetWindow();
      stopPetWindowMotion(window);
      setPetWindowLayoutMode(window, layoutMode);
      persistWindowPosition(window);
      return true;
    },
  );

  ipcMain.handle(
    "pet-window:set-ignore-mouse-events",
    (_event, ignore: boolean) => {
      const window = getPetWindow();
      window.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
      return true;
    },
  );

  ipcMain.handle("float-window:show", () => {
    showFloatWindow();
    return true;
  });

  ipcMain.handle("float-window:hide", () => {
    hideFloatWindow();
    return true;
  });

  ipcMain.handle("float-window:resize", (_event, width: number, height: number) => {
    if (!floatWindow || floatWindow.isDestroyed()) {
      return false;
    }
    // 最小尺寸保护
    const w = Math.max(100, width);
    const h = Math.max(40, height);
    floatWindow.setSize(w, h);
    syncFloatWindowPosition();
    return true;
  });

  ipcMain.handle("desktop:open-control-panel", () => {
    showControlWindow();
    return true;
  });

  ipcMain.handle("desktop:show-pet-context-menu", () => {
    showPetContextMenu();
    return true;
  });

  ipcMain.handle("desktop:quit-app", () => {
    app.quit();
    return true;
  });

  ipcMain.handle("desktop:request-accessibility-permission", () =>
    process.platform === "darwin"
      ? systemPreferences.isTrustedAccessibilityClient(true)
      : false,
  );

  ipcMain.handle("desktop:get-system-info", async () => {
    const systemInfo: {
      currentTime: string;
      foregroundApp: {
        name: string;
        bundleId: string | null;
      } | null;
      battery: {
        isCharging: boolean;
        level: number;
      } | null;
      volume: number;
      muted: boolean;
    } = {
      currentTime: new Date().toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      }),
      foregroundApp: null,
      battery: null,
      volume: 50,
      muted: false,
    };

    // 获取前台应用 (macOS)
    if (process.platform === "darwin") {
      try {
        const { stdout: appName } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true']);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => { stdout += data; });
          child.stderr.on("data", (data) => { stderr += data; });
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          child.on("error", reject);
        });
        
        const name = appName.trim();
        
        // 尝试获取 bundle ID
        let bundleId: string | null = null;
        try {
          const { stdout: bundleOut } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn("osascript", ["-e", `tell application "${name}" to get id`]);
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (data) => { stdout += data; });
            child.stderr.on("data", (data) => { stderr += data; });
            child.on("close", (code) => {
              if (code === 0) resolve({ stdout, stderr });
              else reject(new Error(stderr || `Exit code ${code}`));
            });
            child.on("error", reject);
          });
          bundleId = bundleOut.trim();
        } catch {
          // 忽略错误
        }
        
        systemInfo.foregroundApp = { name, bundleId };
      } catch {
        // 忽略错误
      }
    }

    // 获取电池状态
    try {
      const batteryLevel = process.platform === "darwin" 
        ? require("child_process").execSync("pmset -g batt | grep -oE '[0-9]+%' | tr -d '%'", { encoding: "utf8" }).trim()
        : null;
      const isCharging = process.platform === "darwin"
        ? require("child_process").execSync("pmset -g batt | grep -oE '(charging|discharging|charged)'", { encoding: "utf8" }).trim() !== "discharging"
        : false;
      
      if (batteryLevel) {
        systemInfo.battery = {
          isCharging,
          level: parseInt(batteryLevel, 10),
        };
      }
    } catch {
      // 忽略错误
    }

    // 获取音量 (macOS)
    if (process.platform === "darwin") {
      try {
        const { stdout: volumeOut } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn("osascript", ["-e", "output volume of (get volume settings)"]);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => { stdout += data; });
          child.stderr.on("data", (data) => { stderr += data; });
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          child.on("error", reject);
        });
        systemInfo.volume = parseInt(volumeOut.trim(), 10);
        
        const { stdout: mutedOut } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn("osascript", ["-e", "output muted of (get volume settings)"]);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => { stdout += data; });
          child.stderr.on("data", (data) => { stderr += data; });
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `Exit code ${code}`));
          });
          child.on("error", reject);
        });
        systemInfo.muted = mutedOut.trim() === "true";
      } catch {
        // 忽略错误
      }
    }

    return systemInfo;
  });

  ipcMain.handle(
    "desktop:get-productivity-snapshot",
    async (_event, rawQuery: unknown) =>
      getProductivitySnapshot(normalizeProductivityQuery(rawQuery)),
  );

  ipcMain.handle(
    "desktop:show-system-notification",
    (_event, payload: SystemNotificationPayload) => {
      if (
        !payload ||
        typeof payload.notificationId !== "string" ||
        typeof payload.title !== "string" ||
        typeof payload.body !== "string"
      ) {
        return false;
      }

      return showSystemNotification(payload);
    },
  );

  ipcMain.handle("local-service:get-health", () =>
    requestLocalService({
      pathname: "/health",
    }),
  );

  ipcMain.handle("local-service:get-settings", () =>
    requestLocalService({
      pathname: "/settings/get",
    }),
  );

  ipcMain.handle("local-service:get-pet-state", () =>
    requestLocalService({
      pathname: "/pet/state",
    }),
  );

  ipcMain.handle("local-service:update-pet-state", (_event, payload: unknown) =>
    requestLocalService({
      pathname: "/pet/state/update",
      method: "POST",
      body: payload,
    }),
  );

  ipcMain.handle("local-service:get-chat-session-active", () =>
    requestLocalService({
      pathname: "/chat/session/active",
    }),
  );

  ipcMain.handle(
    "local-service:get-chat-history",
    (_event, query: LocalServiceQuery) =>
      requestLocalService({
        pathname: "/chat/history",
        query,
      }),
  );

  ipcMain.handle(
    "local-service:append-chat-message",
    (_event, payload: unknown) =>
      requestLocalService({
        pathname: "/chat/messages/append",
        method: "POST",
        body: payload,
      }),
  );

  ipcMain.handle("local-service:get-reminder-runtime-status", () =>
    requestLocalService({
      pathname: "/reminder/runtime-status",
    }),
  );

  ipcMain.handle(
    "local-service:acknowledge-reminder",
    (_event, payload: unknown) =>
      requestLocalService({
        pathname: "/reminder/acknowledge",
        method: "POST",
        body: payload,
      }),
  );
};

const ensureLocalServiceReady = async () => {
  try {
    await waitForLocalServiceReady();
  } catch (error) {
    startManagedLocalService();

    try {
      await waitForLocalServiceReady();
    } catch (retryError) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local-service] bootstrap wait failed: ${
          retryError instanceof Error
            ? retryError.message
            : error instanceof Error
              ? error.message
              : "unknown error"
        }`,
      );
    }
  }
};

const createPetWindow = () => {
  const preloadPath = join(currentDir, "preload.cjs");
  const initialPosition = readSavedPosition();

  const window = new BrowserWindow({
    ...petWindowLayouts.compact,
    x: initialPosition.x,
    y: initialPosition.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    title: "桌宠 AI",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.setAlwaysOnTop(true, "floating");
  petWindowLayoutMode = "compact";
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  attachWindowDiagnostics(window, "pet");
  window.webContents.on("context-menu", () => {
    showPetContextMenu();
  });

  window.on("move", () => {
    persistWindowPosition(window);
    syncFloatWindowPosition();
  });
  window.on("close", () => {
    stopPetWindowMotion(window);
    persistWindowPosition(window, {
      immediate: true,
    });
  });
  window.on("closed", () => {
    clearPersistTimer();
    floatWindow?.destroy();
    floatWindow = null;

    if (petWindow === window) {
      petWindow = null;
    }

    refreshStatusItemMenu();
  });

  loadRenderer(window, "pet");
  refreshStatusItemMenu();
  return window;
};

const createFloatWindow = () => {
  const preloadPath = join(currentDir, "preload.cjs");

  const window = new BrowserWindow({
    ...floatWindowSize,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    title: "桌宠 AI 浮动层",
    show: false,
    autoHideMenuBar: true,
    focusable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });

  attachWindowDiagnostics(window, "float");

  window.on("closed", () => {
    if (floatWindow === window) {
      floatWindow = null;
    }
  });

  loadRenderer(window, "float");
  return window;
};

const createControlWindow = () => {
  const preloadPath = join(currentDir, "preload.cjs");

  const window = new BrowserWindow({
    ...panelWindowSize,
    center: true,
    frame: true,
    titleBarStyle: "default",
    transparent: false,
    hasShadow: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    backgroundColor: "#f6e7c5",
    title: "桌宠 AI 控制台",
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });

  attachWindowDiagnostics(window, "panel");
  window.on("closed", () => {
    if (controlWindow === window) {
      controlWindow = null;
    }

    refreshStatusItemMenu();
  });

  loadRenderer(window, "panel");
  refreshStatusItemMenu();
  return window;
};

app.whenReady().then(async () => {
  configureMacApplicationShell();
  createStatusItem();
  startDesktopRuntimeStateSync();
  await ensureLocalServiceReady();
  registerIpcHandlers();
  petWindow = createPetWindow();
  floatWindow = createFloatWindow();

  if (openControlPanelOnLaunch) {
    showControlWindow();
  }

  app.on("activate", () => {
    void writeDesktopRuntimeState();
    showPetWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  clearPersistTimer();
  stopDesktopRuntimeStateSync();
  statusItem?.destroy();
  statusItem = null;
  stopManagedLocalService();
  ipcMain.removeHandler("runtime:get-info");
  ipcMain.removeHandler("pet-window:get-position");
  ipcMain.removeHandler("pet-window:move-to");
  ipcMain.removeHandler("pet-window:animate-to");
  ipcMain.removeHandler("pet-window:move-randomly");
  ipcMain.removeHandler("pet-window:cancel-motion");
  ipcMain.removeHandler("pet-window:set-layout-mode");
  ipcMain.removeHandler("pet-window:set-ignore-mouse-events");
  ipcMain.removeHandler("desktop:open-control-panel");
  ipcMain.removeHandler("desktop:show-pet-context-menu");
  ipcMain.removeHandler("desktop:quit-app");
  ipcMain.removeHandler("desktop:request-accessibility-permission");
  ipcMain.removeHandler("desktop:get-system-info");
  ipcMain.removeHandler("desktop:get-productivity-snapshot");
  ipcMain.removeHandler("desktop:show-system-notification");
  ipcMain.removeHandler("local-service:get-health");
  ipcMain.removeHandler("local-service:get-settings");
  ipcMain.removeHandler("local-service:get-pet-state");
  ipcMain.removeHandler("local-service:update-pet-state");
  ipcMain.removeHandler("local-service:get-chat-session-active");
  ipcMain.removeHandler("local-service:get-chat-history");
  ipcMain.removeHandler("local-service:append-chat-message");
  ipcMain.removeHandler("local-service:get-reminder-runtime-status");
  ipcMain.removeHandler("local-service:acknowledge-reminder");
});
