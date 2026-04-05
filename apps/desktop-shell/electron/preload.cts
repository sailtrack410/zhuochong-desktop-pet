const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");

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
