import { z } from "zod";

export const sessionIdSchema = z.string().min(1);
export const messageIdSchema = z.string().min(1);
export const reminderIdSchema = z.string().min(1);
export const memoryIdSchema = z.string().min(1);

export type SessionId = z.infer<typeof sessionIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type ReminderId = z.infer<typeof reminderIdSchema>;
export type MemoryId = z.infer<typeof memoryIdSchema>;
