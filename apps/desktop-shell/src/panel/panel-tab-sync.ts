export type PanelTab = "chat" | "memory" | "settings" | "status";

type PanelTabRequestPayload = {
  requestId: string;
  requestedAt: number;
  tab: PanelTab;
};

const panelTabStorageKey = "zhuochong:panel-tab";
const panelTabChannelName = "zhuochong:panel-tab";
const panelTabEventName = "zhuochong:panel-tab";

const isPanelTab = (value: unknown): value is PanelTab =>
  value === "chat" || value === "memory" || value === "settings";

const parsePanelTabRequest = (
  value: string | null | undefined,
): PanelTabRequestPayload | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<PanelTabRequestPayload>;
    if (!isPanelTab(parsed.tab)) {
      return null;
    }

    return {
      requestId:
        typeof parsed.requestId === "string"
          ? parsed.requestId
          : `panel-tab-${Date.now()}`,
      requestedAt:
        typeof parsed.requestedAt === "number"
          ? parsed.requestedAt
          : Date.now(),
      tab: parsed.tab,
    };
  } catch {
    return null;
  }
};

const readPanelTabRequest = (): PanelTabRequestPayload | null => {
  try {
    return parsePanelTabRequest(window.localStorage.getItem(panelTabStorageKey));
  } catch {
    return null;
  }
};

const writePanelTabRequest = (payload: PanelTabRequestPayload): void => {
  try {
    window.localStorage.setItem(panelTabStorageKey, JSON.stringify(payload));
  } catch {
    // 忽略存储失败，仍然继续走窗口内/跨窗口广播。
  }
};

export const clearPanelTabRequest = (): void => {
  try {
    window.localStorage.removeItem(panelTabStorageKey);
  } catch {
    // 忽略存储失败。
  }
};

export const publishPanelTabRequest = (tab: PanelTab): void => {
  const payload: PanelTabRequestPayload = {
    requestId: `panel-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedAt: Date.now(),
    tab,
  };

  writePanelTabRequest(payload);

  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(panelTabChannelName);
    channel.postMessage(payload);
    channel.close();
  }

  window.dispatchEvent(
    new CustomEvent<PanelTabRequestPayload>(panelTabEventName, {
      detail: payload,
    }),
  );
};

export const consumePanelTabRequest = (fallback: PanelTab = "chat"): PanelTab => {
  const payload = readPanelTabRequest();
  if (!payload) {
    return fallback;
  }

  clearPanelTabRequest();
  return payload.tab;
};

export const subscribePanelTabRequests = (
  listener: (tab: PanelTab) => void,
): (() => void) => {
  const handlePayload = (
    payload: PanelTabRequestPayload | null | undefined,
  ) => {
    if (!payload || !isPanelTab(payload.tab)) {
      return;
    }

    listener(payload.tab);
  };

  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(panelTabChannelName)
      : null;

  const handleMessage = (event: MessageEvent<PanelTabRequestPayload>) => {
    handlePayload(event.data);
  };
  const handleWindowEvent = (event: Event) => {
    const customEvent = event as CustomEvent<PanelTabRequestPayload>;
    handlePayload(customEvent.detail);
  };
  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key !== panelTabStorageKey) {
      return;
    }

    handlePayload(parsePanelTabRequest(event.newValue));
  };

  channel?.addEventListener("message", handleMessage);
  window.addEventListener(panelTabEventName, handleWindowEvent);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    channel?.removeEventListener("message", handleMessage);
    channel?.close();
    window.removeEventListener(panelTabEventName, handleWindowEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
};
