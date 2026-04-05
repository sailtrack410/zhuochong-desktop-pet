type ComposerActivityPayload = {
  hasText: boolean;
  isFocused: boolean;
  isComposing: boolean;
};

const composerActivityChannelName = "zhuochong:composer-activity";
const composerActivityEventName = "zhuochong:composer-activity";

export const publishComposerActivity = (
  payload: ComposerActivityPayload,
): void => {
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(composerActivityChannelName);
    channel.postMessage(payload);
    channel.close();
  }

  window.dispatchEvent(
    new CustomEvent<ComposerActivityPayload>(composerActivityEventName, {
      detail: payload,
    }),
  );
};

export const subscribeComposerActivity = (
  listener: (payload: ComposerActivityPayload) => void,
): (() => void) => {
  const handlePayload = (payload: ComposerActivityPayload | null | undefined) => {
    if (!payload) {
      return;
    }

    listener(payload);
  };

  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(composerActivityChannelName)
      : null;

  const handleMessage = (event: MessageEvent<ComposerActivityPayload>) => {
    handlePayload(event.data);
  };
  const handleWindowEvent = (event: Event) => {
    const customEvent = event as CustomEvent<ComposerActivityPayload>;
    handlePayload(customEvent.detail);
  };

  channel?.addEventListener("message", handleMessage);
  window.addEventListener(composerActivityEventName, handleWindowEvent);

  return () => {
    channel?.removeEventListener("message", handleMessage);
    channel?.close();
    window.removeEventListener(composerActivityEventName, handleWindowEvent);
  };
};
