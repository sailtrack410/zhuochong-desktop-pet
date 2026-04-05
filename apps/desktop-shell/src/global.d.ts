interface Window {
  zhuochong?: ZhuochongDesktopBridge;
}

type ZhuochongRuntimeInfo = {
  version: string;
  platform: NodeJS.Platform;
};

type ZhuochongSystemInfo = {
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
};

type ZhuochongProductivityScope = "today" | "tomorrow" | "upcoming";

type ZhuochongCalendarEvent = {
  title: string;
  calendarName: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  location?: string | null;
};

type ZhuochongReminderItem = {
  title: string;
  listName: string;
  dueAt?: string;
  completed: boolean;
};

type ZhuochongProductivitySnapshot = {
  queriedAt: string;
  scope: ZhuochongProductivityScope;
  events: ZhuochongCalendarEvent[];
  reminders: ZhuochongReminderItem[];
  availability: {
    calendar: boolean;
    reminders: boolean;
  };
  errors: {
    calendar?: string;
    reminders?: string;
  };
};

type ZhuochongChatHistoryQuery = {
  sessionId: string;
  limit?: number;
  beforeMessageId?: string;
};

type ZhuochongDesktopBridge = {
  version: string;
  runtime: {
    getInfo: () => Promise<ZhuochongRuntimeInfo>;
  };
  petWindow: {
    getPosition: () => Promise<{ x: number; y: number }>;
    moveTo: (position: { x: number; y: number }) => Promise<{ x: number; y: number }>;
    animateTo: (
      position: { x: number; y: number },
      durationMs?: number,
    ) => Promise<{ x: number; y: number }>;
    moveRandomly: () => Promise<{ x: number; y: number }>;
    cancelMotion: () => Promise<boolean>;
    setIgnoreMouseEvents: (ignore: boolean) => Promise<boolean>;
    setLayoutMode: (mode: "compact" | "expanded") => Promise<boolean>;
  };
  floatWindow: {
    show: () => Promise<boolean>;
    hide: () => Promise<boolean>;
    resize: (width: number, height: number) => Promise<boolean>;
  };
  desktop: {
    openControlPanel: () => Promise<boolean>;
    showPetContextMenu: () => Promise<boolean>;
    quitApp: () => Promise<boolean>;
    showSystemNotification?: (payload: {
      notificationId: string;
      title: string;
      body: string;
    }) => Promise<boolean>;
    requestAccessibilityPermission?: () => Promise<boolean>;
    getSystemInfo: () => Promise<ZhuochongSystemInfo>;
    getProductivitySnapshot?: (query: {
      scope: ZhuochongProductivityScope;
      includeEvents: boolean;
      includeReminders: boolean;
      limit?: number;
    }) => Promise<ZhuochongProductivitySnapshot>;
  };
  localService: {
    baseUrl: string;
    getHealth: () => Promise<unknown>;
    getSettings: () => Promise<unknown>;
    getPetState: () => Promise<unknown>;
    updatePetState: (payload: unknown) => Promise<unknown>;
    getActiveChatSession: () => Promise<unknown>;
    getChatHistory: (query: ZhuochongChatHistoryQuery) => Promise<unknown>;
    appendChatMessage: (payload: unknown) => Promise<unknown>;
    getReminderRuntimeStatus?: () => Promise<unknown>;
    acknowledgeReminder: (payload: unknown) => Promise<unknown>;
  };
};
