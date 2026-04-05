import { z } from "zod";

import { chatMessageSchema } from "./chat.js";
import { petStateSnapshotSchema } from "./pet-state.js";
import { reminderPayloadSchema } from "./reminder.js";
import { settingsDtoSchema } from "./settings.js";
import { systemContextSchema } from "./system-context.js";

const baseEventSchema = z.object({
  eventId: z.string().min(1),
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1).optional(),
});

export const petStateChangedEventSchema = baseEventSchema.extend({
  type: z.literal("PET_STATE_CHANGED"),
  payload: z.object({
    snapshot: petStateSnapshotSchema,
  }),
});

export const chatMessageReceivedEventSchema = baseEventSchema.extend({
  type: z.literal("CHAT_MESSAGE_RECEIVED"),
  payload: z.object({
    message: chatMessageSchema,
  }),
});

export const reminderReadyEventSchema = baseEventSchema.extend({
  type: z.literal("REMINDER_READY"),
  payload: z.object({
    reminder: reminderPayloadSchema,
  }),
});

export const systemContextUpdatedEventSchema = baseEventSchema.extend({
  type: z.literal("SYSTEM_CONTEXT_UPDATED"),
  payload: z.object({
    context: systemContextSchema,
  }),
});

export const settingsUpdatedEventSchema = baseEventSchema.extend({
  type: z.literal("SETTINGS_UPDATED"),
  payload: z.object({
    settings: settingsDtoSchema,
  }),
});

export const uiEventEnvelopeSchema = z.discriminatedUnion("type", [
  petStateChangedEventSchema,
  chatMessageReceivedEventSchema,
  reminderReadyEventSchema,
  systemContextUpdatedEventSchema,
  settingsUpdatedEventSchema,
]);

export type UiEventEnvelope = z.infer<typeof uiEventEnvelopeSchema>;
