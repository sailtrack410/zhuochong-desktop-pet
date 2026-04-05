import { z } from "zod";

import { createCapabilityInfoSchema } from "./common/capability.js";
import { createContractResultSchema } from "./common/envelope.js";

export const batteryInfoSchema = createCapabilityInfoSchema(
  z.object({
    percent: z.number().min(0).max(100),
    isCharging: z.boolean(),
  }),
);

export const idleInfoSchema = createCapabilityInfoSchema(
  z.object({
    state: z.enum(["active", "idle"]),
    idleSeconds: z.number().nonnegative(),
  }),
);

export const weatherInfoSchema = createCapabilityInfoSchema(
  z.object({
    conditionText: z.string().min(1),
    temperatureC: z.number().optional(),
  }),
);

export const calendarInfoSchema = createCapabilityInfoSchema(
  z.object({
    nextEventTitle: z.string().min(1).optional(),
    nextEventStartAt: z.string().datetime().optional(),
  }),
);

export const foregroundAppInfoSchema = createCapabilityInfoSchema(
  z.object({
    appName: z.string().min(1),
  }),
);

export const systemContextSchema = z.object({
  observedAt: z.string().datetime(),
  timeOfDay: z.enum(["morning", "afternoon", "evening", "night"]),
  battery: batteryInfoSchema,
  idle: idleInfoSchema,
  weather: weatherInfoSchema,
  calendar: calendarInfoSchema,
  foregroundApp: foregroundAppInfoSchema,
});

export const systemContextResultSchema = createContractResultSchema(
  systemContextSchema,
);

export type SystemContextDto = z.infer<typeof systemContextSchema>;
