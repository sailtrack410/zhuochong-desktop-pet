import { nowIso } from "@zhuochong/shared";

import type { AppSettings } from "../domain/models.js";

const resolveEnvValue = (...keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return "";
};

export const defaultSettings = (): AppSettings => ({
  settingsId: "default",
  model: {
    baseUrl: resolveEnvValue("ZHUOCHONG_MODEL_BASE_URL", "OPENAI_BASE_URL"),
    modelName: resolveEnvValue("ZHUOCHONG_MODEL_NAME", "OPENAI_MODEL"),
    ...(resolveEnvValue(
      "ZHUOCHONG_MODEL_API_KEY",
      "OPENAI_API_KEY",
    )
      ? {
          apiKeyEncrypted: resolveEnvValue(
            "ZHUOCHONG_MODEL_API_KEY",
            "OPENAI_API_KEY",
          ),
        }
      : {}),
  },
  behavior: {
    proactivityLevel: "medium",
    remindersEnabled: true,
    silentWhenFullscreen: true,
    silentWhenFocusMode: true,
  },
  pet: {
    displayName: "Pixel Cat",
    pixelScale: 3,
    motionFrequency: "medium",
    sleepTendency: "balanced",
    moveDistance: "medium",
    composerAutoHideSeconds: 9,
  },
  capabilities: {
    calendarEnabled: true,
    weatherEnabled: true,
    foregroundAppEnabled: false,
    ttsEnabled: false,
  },
  updatedAt: nowIso(),
});
