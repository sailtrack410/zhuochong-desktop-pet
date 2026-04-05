import { z } from "zod";

import { createContractResultSchema } from "./common/envelope.js";
import { messageIdSchema, reminderIdSchema, sessionIdSchema } from "./common/ids.js";
import {
  petBusinessStateSchema,
  petMoodSchema,
  petVisualStateSchema,
} from "./common/enums.js";

export const chatMessageSchema = z.object({
  messageId: messageIdSchema,
  sessionId: sessionIdSchema,
  role: z.enum(["user", "assistant", "system"]),
  source: z.enum(["chat", "reminder", "system"]),
  text: z.string().min(1),
  createdAt: z.string().datetime(),
  relatedReminderId: reminderIdSchema.optional(),
});

export const chatSessionSchema = z.object({
  sessionId: sessionIdSchema,
  status: z.enum(["active", "archived"]),
  startedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime(),
});

export const chatRespondRequestSchema = z.object({
  sessionId: sessionIdSchema,
  messageId: messageIdSchema,
  text: z.string().min(1),
  trigger: z.enum(["pet_click", "manual_input", "reminder_followup"]),
  relatedReminderId: reminderIdSchema.optional(),
});

export const chatRespondResponseSchema = z.object({
  sessionId: sessionIdSchema,
  assistantMessage: chatMessageSchema,
  petReaction: z
    .object({
      nextBusinessState: petBusinessStateSchema,
      nextVisualState: petVisualStateSchema,
      mood: petMoodSchema,
      bubbleMode: z.enum(["panel", "floating"]),
      highlightMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export const chatRespondResultSchema = createContractResultSchema(
  chatRespondResponseSchema,
);

export const chatAppendMessageRequestSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  role: z.enum(["user", "assistant", "system"]),
  source: z.enum(["chat", "reminder", "system"]),
  text: z.string().min(1),
  relatedReminderId: reminderIdSchema.optional(),
});

export const chatAppendMessageResponseSchema = z.object({
  session: chatSessionSchema,
  message: chatMessageSchema,
});

export const chatAppendMessageResultSchema = createContractResultSchema(
  chatAppendMessageResponseSchema,
);

export const chatHistoryQuerySchema = z.object({
  sessionId: sessionIdSchema,
  limit: z.number().int().positive().max(200).optional(),
  beforeMessageId: messageIdSchema.optional(),
});

export const chatHistorySchema = z.object({
  sessionId: sessionIdSchema,
  messages: z.array(chatMessageSchema),
  hasMore: z.boolean(),
});

export const chatSessionResultSchema = createContractResultSchema(chatSessionSchema);
export const chatHistoryResultSchema = createContractResultSchema(chatHistorySchema);

export type ChatMessageDto = z.infer<typeof chatMessageSchema>;
export type ChatSessionDto = z.infer<typeof chatSessionSchema>;
export type ChatRespondRequest = z.infer<typeof chatRespondRequestSchema>;
export type ChatRespondResponse = z.infer<typeof chatRespondResponseSchema>;
export type ChatAppendMessageRequest = z.infer<typeof chatAppendMessageRequestSchema>;
export type ChatAppendMessageResponse = z.infer<typeof chatAppendMessageResponseSchema>;
export type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>;
export type ChatHistoryDto = z.infer<typeof chatHistorySchema>;
