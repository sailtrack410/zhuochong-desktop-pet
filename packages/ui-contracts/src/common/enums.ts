import { z } from "zod";

export const contractVersionSchema = z.literal("2026-04-v1");
export const contractSourceSchema = z.enum(["renderer", "main", "local-service"]);

export const petBusinessStateSchema = z.enum([
  "idle",
  "chatting",
  "observing",
  "reacting",
  "reminding",
  "sleeping",
  "muted",
]);

export const petVisualStateSchema = z.enum([
  "idle",
  "sleep",
  "move",
  "run",
  "drag",
  "click",
  "hurt",
  "hide",
]);

export const petMoodSchema = z.enum([
  "neutral",
  "happy",
  "curious",
  "concerned",
  "sleepy",
  "annoyed",
]);

export const proactivityLevelSchema = z.enum(["low", "medium", "high"]);

export const reminderCategorySchema = z.enum([
  "companion",
  "task",
  "status",
  "emotional",
]);

export const reminderSourceSchema = z.enum([
  "time",
  "battery",
  "weather",
  "idle",
  "calendar",
  "manual",
]);

export const capabilityStateSchema = z.enum([
  "ok",
  "unsupported",
  "denied",
  "error",
  "disabled",
]);

export type ContractVersion = z.infer<typeof contractVersionSchema>;
export type ContractSource = z.infer<typeof contractSourceSchema>;
export type PetBusinessState = z.infer<typeof petBusinessStateSchema>;
export type PetVisualState = z.infer<typeof petVisualStateSchema>;
export type PetMood = z.infer<typeof petMoodSchema>;
export type ProactivityLevel = z.infer<typeof proactivityLevelSchema>;
export type ReminderCategory = z.infer<typeof reminderCategorySchema>;
export type ReminderSource = z.infer<typeof reminderSourceSchema>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
