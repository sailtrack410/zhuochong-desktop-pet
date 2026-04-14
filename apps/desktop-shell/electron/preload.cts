const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");

type IpcSubscriptionListener<TValue> = (value: TValue) => void;

const subscribeToIpcChannel = <TValue,>(
  channel: string,
  listener: IpcSubscriptionListener<TValue>,
) => {
  const handler = (_event: Electron.IpcRendererEvent, value: TValue) => {
    listener(value);
  };

  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

contextBridge.exposeInMainWorld("zhuochong", {
  version: "0.1.0",
  runtime: {
    getInfo: () => ipcRenderer.invoke("runtime:get-info"),
  },
  petWindow: {
    getPosition: () => ipcRenderer.invoke("pet-window:get-position"),
    moveTo: (position: { x: number; y: number }) =>
      ipcRenderer.invoke("pet-window:move-to", position),
    animateTo: (
      position: { x: number; y: number },
      durationMs?: number,
    ) => ipcRenderer.invoke("pet-window:animate-to", position, durationMs),
    moveRandomly: () => ipcRenderer.invoke("pet-window:move-randomly"),
    cancelMotion: () => ipcRenderer.invoke("pet-window:cancel-motion"),
    setIgnoreMouseEvents: (ignore: boolean) =>
      ipcRenderer.invoke("pet-window:set-ignore-mouse-events", ignore),
    setLayoutMode: (mode: "compact" | "expanded") =>
      ipcRenderer.invoke("pet-window:set-layout-mode", mode),
  },
  floatWindow: {
    show: () => ipcRenderer.invoke("float-window:show"),
    hide: () => ipcRenderer.invoke("float-window:hide"),
    resize: (width: number, height: number) =>
      ipcRenderer.invoke("float-window:resize", width, height),
  },
  desktop: {
    openControlPanel: () => ipcRenderer.invoke("desktop:open-control-panel"),
    getAppearance: () => ipcRenderer.invoke("desktop:get-appearance"),
    updateThemeMode: (themeMode: "system" | "light" | "dark") =>
      ipcRenderer.invoke("desktop:update-theme-mode", themeMode),
    hideControlPanel: () => ipcRenderer.invoke("desktop:hide-control-panel"),
    showPet: () => ipcRenderer.invoke("desktop:show-pet"),
    hidePet: () => ipcRenderer.invoke("desktop:hide-pet"),
    showPetContextMenu: () =>
      ipcRenderer.invoke("desktop:show-pet-context-menu"),
    quitApp: () => ipcRenderer.invoke("desktop:quit-app"),
    showSystemNotification: (payload: unknown) =>
      ipcRenderer.invoke("desktop:show-system-notification", payload),
    requestAccessibilityPermission: () =>
      ipcRenderer.invoke("desktop:request-accessibility-permission"),
    getSystemInfo: () => ipcRenderer.invoke("desktop:get-system-info"),
    getProductivitySnapshot: (query: {
      scope: "today" | "tomorrow" | "upcoming";
      includeEvents: boolean;
      includeReminders: boolean;
      limit?: number;
    }) => ipcRenderer.invoke("desktop:get-productivity-snapshot", query),
    subscribeAppearanceChanged: (listener: (state: unknown) => void) =>
      subscribeToIpcChannel("desktop:appearance-changed", listener),
  },
  clipboard: {
    getState: () => ipcRenderer.invoke("clipboard:get-state"),
    showPanel: () => ipcRenderer.invoke("clipboard:show-panel"),
    hidePanel: () => ipcRenderer.invoke("clipboard:hide-panel"),
    togglePanelPinned: () => ipcRenderer.invoke("clipboard:toggle-panel-pinned"),
    updateShortcut: (accelerator: string) =>
      ipcRenderer.invoke("clipboard:update-shortcut", accelerator),
    writeHistoryItem: (itemId: string) =>
      ipcRenderer.invoke("clipboard:write-history-item", itemId),
    togglePinned: (itemId: string) =>
      ipcRenderer.invoke("clipboard:toggle-pinned", itemId),
    deleteHistoryItem: (itemId: string) =>
      ipcRenderer.invoke("clipboard:delete-history-item", itemId),
    clearHistory: () => ipcRenderer.invoke("clipboard:clear-history"),
    subscribeStateChanged: (listener: (state: unknown) => void) =>
      subscribeToIpcChannel("clipboard:state-changed", listener),
  },
  localService: {
    baseUrl: process.env.LOCAL_SERVICE_BASE_URL ?? "http://127.0.0.1:3765",
    getHealth: () => ipcRenderer.invoke("local-service:get-health"),
    getSettings: () => ipcRenderer.invoke("local-service:get-settings"),
    getPetState: () => ipcRenderer.invoke("local-service:get-pet-state"),
    updatePetState: (payload: unknown) =>
      ipcRenderer.invoke("local-service:update-pet-state", payload),
    getActiveChatSession: () =>
      ipcRenderer.invoke("local-service:get-chat-session-active"),
    getChatHistory: (query: {
      sessionId: string;
      limit?: number;
      beforeMessageId?: string;
    }) => ipcRenderer.invoke("local-service:get-chat-history", query),
    appendChatMessage: (payload: unknown) =>
      ipcRenderer.invoke("local-service:append-chat-message", payload),
    getReminderRuntimeStatus: () =>
      ipcRenderer.invoke("local-service:get-reminder-runtime-status"),
    acknowledgeReminder: (payload: unknown) =>
      ipcRenderer.invoke("local-service:acknowledge-reminder", payload),
  },
});
