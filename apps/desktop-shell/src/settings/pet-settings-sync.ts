import type { SettingsDto } from "@zhuochong/ui-contracts";

type SyncedPetSettings = Pick<
  SettingsDto["pet"],
  | "displayName"
  | "pixelScale"
  | "motionFrequency"
  | "sleepTendency"
  | "moveDistance"
  | "composerAutoHideSeconds"
> & {
  proactivityLevel: SettingsDto["behavior"]["proactivityLevel"];
};

const petSettingsChannelName = "zhuochong:pet-settings";
const petSettingsEventName = "zhuochong:pet-settings";

export const publishPetSettingsUpdate = (
  payload: SyncedPetSettings,
): void => {
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(petSettingsChannelName);
    channel.postMessage(payload);
    channel.close();
  }

  window.dispatchEvent(
    new CustomEvent<SyncedPetSettings>(petSettingsEventName, {
      detail: payload,
    }),
  );
};

export const subscribePetSettingsUpdates = (
  listener: (payload: SyncedPetSettings) => void,
): (() => void) => {
  const handleEvent = (payload: SyncedPetSettings | null | undefined) => {
    if (!payload) {
      return;
    }

    listener(payload);
  };

  const channel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(petSettingsChannelName)
      : null;

  const handleMessage = (event: MessageEvent<SyncedPetSettings>) => {
    handleEvent(event.data);
  };
  const handleWindowEvent = (event: Event) => {
    const customEvent = event as CustomEvent<SyncedPetSettings>;
    handleEvent(customEvent.detail);
  };

  channel?.addEventListener("message", handleMessage);
  window.addEventListener(petSettingsEventName, handleWindowEvent);

  return () => {
    channel?.removeEventListener("message", handleMessage);
    channel?.close();
    window.removeEventListener(petSettingsEventName, handleWindowEvent);
  };
};
