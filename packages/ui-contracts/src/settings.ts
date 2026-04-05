import { z } from "zod";

import { createContractResultSchema } from "./common/envelope.js";
import { capabilityStateSchema, proactivityLevelSchema } from "./common/enums.js";

export const petMotionFrequencySchema = z.enum(["low", "medium", "high"]);
export const petSleepTendencySchema = z.enum(["easy", "balanced", "late"]);
export const petMoveDistanceSchema = z.enum(["short", "medium", "long"]);
export const petComposerAutoHideSecondsSchema = z.union([
  z.literal(5),
  z.literal(9),
  z.literal(15),
]);

export const settingsDtoSchema = z.object({
  model: z.object({
    baseUrl: z.string(),
    modelName: z.string(),
    apiKeyState: z.enum(["configured", "missing"]),
  }),
  behavior: z.object({
    proactivityLevel: proactivityLevelSchema,
    remindersEnabled: z.boolean(),
    silentWhenFullscreen: z.boolean(),
    silentWhenFocusMode: z.boolean(),
  }),
  pet: z.object({
    displayName: z.string().min(1),
    pixelScale: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
    ]),
    motionFrequency: petMotionFrequencySchema,
    sleepTendency: petSleepTendencySchema,
    moveDistance: petMoveDistanceSchema,
    composerAutoHideSeconds: petComposerAutoHideSecondsSchema,
  }),
  capabilities: z.object({
    calendar: capabilityStateSchema,
    weather: capabilityStateSchema,
    foregroundApp: capabilityStateSchema,
    tts: capabilityStateSchema,
  }),
  updatedAt: z.string().datetime(),
});

export const settingsUpdateRequestSchema = z.object({
  patch: z.object({
    model: z
      .object({
        baseUrl: z.string().optional(),
        modelName: z.string().optional(),
        apiKeyInput: z.string().optional(),
        clearApiKey: z.boolean().optional(),
      })
      .optional(),
    behavior: z
      .object({
        proactivityLevel: proactivityLevelSchema.optional(),
        remindersEnabled: z.boolean().optional(),
        silentWhenFullscreen: z.boolean().optional(),
        silentWhenFocusMode: z.boolean().optional(),
      })
      .optional(),
    pet: z
      .object({
        displayName: z.string().optional(),
        pixelScale: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
        ]).optional(),
        motionFrequency: petMotionFrequencySchema.optional(),
        sleepTendency: petSleepTendencySchema.optional(),
        moveDistance: petMoveDistanceSchema.optional(),
        composerAutoHideSeconds: petComposerAutoHideSecondsSchema.optional(),
      })
      .optional(),
    capabilities: z
      .object({
        calendar: z.boolean().optional(),
        weather: z.boolean().optional(),
        foregroundApp: z.boolean().optional(),
        tts: z.boolean().optional(),
      })
      .optional(),
  }),
});

export const settingsResultSchema = createContractResultSchema(settingsDtoSchema);

export type PetMotionFrequency = z.infer<typeof petMotionFrequencySchema>;
export type PetSleepTendency = z.infer<typeof petSleepTendencySchema>;
export type PetMoveDistance = z.infer<typeof petMoveDistanceSchema>;
export type PetComposerAutoHideSeconds = z.infer<
  typeof petComposerAutoHideSecondsSchema
>;
export type SettingsDto = z.infer<typeof settingsDtoSchema>;
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;
