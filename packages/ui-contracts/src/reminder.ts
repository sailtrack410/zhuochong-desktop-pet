import { z } from "zod";

import { createContractResultSchema } from "./common/envelope.js";
import { reminderIdSchema } from "./common/ids.js";
import {
  proactivityLevelSchema,
  reminderCategorySchema,
  reminderSourceSchema,
} from "./common/enums.js";

export const reminderPayloadSchema = z.object({
  reminderId: reminderIdSchema,
  category: reminderCategorySchema,
  source: reminderSourceSchema,
  priority: z.enum(["low", "medium", "high"]),
  text: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  actionLabel: z.string().min(1).optional(),
});

export const reminderAcknowledgeRequestSchema = z.object({
  reminderId: reminderIdSchema,
  action: z.enum(["dismiss", "open_chat"]),
});

export const reminderAcknowledgeResponseSchema = z.object({
  reminderId: reminderIdSchema,
  acknowledged: z.literal(true),
});

export const reminderRecordSchema = z.object({
  reminderId: reminderIdSchema,
  category: reminderCategorySchema,
  source: reminderSourceSchema,
  priority: z.enum(["low", "medium", "high"]),
  status: z.enum(["pending", "ready", "dismissed", "opened_chat", "suppressed"]),
  text: z.string().min(1),
  triggeredAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime().optional(),
  suppressionReason: z.string().min(1).optional(),
});

export const reminderCreateRequestSchema = z.object({
  text: z.string().min(1),
  dueAt: z.string().datetime(),
});

export const reminderCreateResponseSchema = reminderRecordSchema;

export const reminderListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
});

export const reminderSilentReasonSchema = z.enum([
  "fullscreen",
  "focus_mode",
]);

export const reminderRuntimeStatusSchema = z.object({
  remindersEnabled: z.boolean(),
  proactivityLevel: proactivityLevelSchema,
  silentWhenFullscreen: z.boolean(),
  silentWhenFocusMode: z.boolean(),
  isSilent: z.boolean(),
  activeSilentReasons: z.array(reminderSilentReasonSchema),
  detected: z.object({
    frontmostFullscreen: z.boolean(),
    frontmostFullscreenAvailable: z.boolean(),
    focusModeEnabled: z.boolean(),
    focusModeDetectionAvailable: z.boolean(),
  }),
  checkedAt: z.string().datetime(),
});

export const reminderListResultSchema = createContractResultSchema(
  z.object({
    reminders: z.array(reminderRecordSchema),
    total: z.number().int().nonnegative(),
  }),
);

export const reminderAcknowledgeResultSchema = createContractResultSchema(
  reminderAcknowledgeResponseSchema,
);

export const reminderCreateResultSchema = createContractResultSchema(
  reminderCreateResponseSchema,
);

export const reminderRuntimeStatusResultSchema = createContractResultSchema(
  reminderRuntimeStatusSchema,
);

export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;
export type ReminderRecordDto = z.infer<typeof reminderRecordSchema>;
export type ReminderListQuery = z.infer<typeof reminderListQuerySchema>;
export type ReminderListDto = {
  reminders: ReminderRecordDto[];
  total: number;
};
export type ReminderSilentReason = z.infer<typeof reminderSilentReasonSchema>;
export type ReminderRuntimeStatusDto = z.infer<
  typeof reminderRuntimeStatusSchema
>;
export type ReminderCreateRequest = z.infer<
  typeof reminderCreateRequestSchema
>;
export type ReminderCreateResponse = z.infer<
  typeof reminderCreateResponseSchema
>;
export type ReminderAcknowledgeRequest = z.infer<
  typeof reminderAcknowledgeRequestSchema
>;
export type ReminderAcknowledgeResponse = z.infer<
  typeof reminderAcknowledgeResponseSchema
>;
