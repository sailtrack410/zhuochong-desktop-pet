import { z } from "zod";

import { createContractResultSchema } from "./common/envelope.js";
import { reminderIdSchema } from "./common/ids.js";
import {
  petBusinessStateSchema,
  petMoodSchema,
  petVisualStateSchema,
} from "./common/enums.js";

export const petStateSnapshotSchema = z.object({
  businessState: petBusinessStateSchema,
  visualState: petVisualStateSchema,
  mood: petMoodSchema,
  canInterrupt: z.boolean(),
  isSilentMode: z.boolean(),
  currentInteraction: z.enum([
    "none",
    "chat_panel",
    "bubble",
    "dragging",
    "reminder",
  ]),
  activeReminderId: reminderIdSchema.optional(),
  updatedAt: z.string().datetime(),
});

export const petStateUpdateRequestSchema = z.object({
  businessState: petBusinessStateSchema,
  visualState: petVisualStateSchema,
  mood: petMoodSchema,
  trigger: z.enum(["chat", "reminder", "system", "drag", "manual"]),
});

export const petStateSnapshotResultSchema = createContractResultSchema(
  petStateSnapshotSchema,
);

export const petStateUpdateResultSchema = createContractResultSchema(
  petStateSnapshotSchema,
);

export type PetStateSnapshot = z.infer<typeof petStateSnapshotSchema>;
export type PetStateUpdateRequest = z.infer<typeof petStateUpdateRequestSchema>;
