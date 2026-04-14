import { z } from "zod";

import { createContractResultSchema } from "./common/envelope.js";

export const memoryCategorySchema = z.enum([
  "preference",
  "habit",
  "profile",
  "event",
  "relationship",
]);

export const memoryRecordSchema = z.object({
  memoryId: z.string(),
  category: memoryCategorySchema,
  key: z.string(),
  valueText: z.string(),
  confidence: z.number().min(0).max(1),
  source: z.enum(["conversation", "derived"]),
  firstObservedAt: z.string().datetime(),
  lastConfirmedAt: z.string().datetime(),
  status: z.enum(["active", "superseded", "discarded"]),
});

export const memoryListQuerySchema = z.object({
  category: memoryCategorySchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const memoryListResultSchema = createContractResultSchema(
  z.object({
    memories: z.array(memoryRecordSchema),
    total: z.number().int().nonnegative(),
  }),
);

export const diaryEntrySchema = z.object({
  diaryId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  diaryText: z.string(),
  highlights: z.array(z.string()),
  memoryCount: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});

export const diaryListQuerySchema = z.object({
  limit: z.number().int().min(1).max(30).optional(),
});

export const diaryListResultSchema = createContractResultSchema(
  z.object({
    entries: z.array(diaryEntrySchema),
  }),
);

export const diaryGetQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const diaryGetResultSchema = createContractResultSchema(
  diaryEntrySchema.nullable(),
);

export const companionEventTypeSchema = z.enum([
  "random_event",
  "care_action",
  "chat_affinity",
]);

export const companionEventRecordRequestSchema = z.object({
  type: companionEventTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  relationStage: z.string().min(1),
  affinityDelta: z.number().int().min(-2).max(2).optional(),
  occurredAt: z.string().datetime().optional(),
});

export const companionEventRecordResponseSchema = z.object({
  memories: z.array(memoryRecordSchema),
  diary: diaryEntrySchema,
});

export const companionEventRecordResultSchema = createContractResultSchema(
  companionEventRecordResponseSchema,
);

export const companionProfileSummarySchema = z.object({
  petName: z.string().min(1),
  relationStage: z.string().min(1),
  summaryText: z.string(),
  highlights: z.array(z.string()),
  generatedAt: z.string().datetime(),
});

export const companionProfileSummaryResultSchema = createContractResultSchema(
  companionProfileSummarySchema,
);

export const explicitMemoryRememberRequestSchema = z.object({
  text: z.string().min(1),
  category: z.enum(["preference", "profile"]).optional(),
});

export const explicitMemoryRememberResponseSchema = z.object({
  memory: memoryRecordSchema,
});

export const explicitMemoryRememberResultSchema = createContractResultSchema(
  explicitMemoryRememberResponseSchema,
);


export type MemoryCategory = z.infer<typeof memoryCategorySchema>;
export type MemoryRecordDto = z.infer<typeof memoryRecordSchema>;
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;
export type MemoryListDto = {
  memories: MemoryRecordDto[];
  total: number;
};
export type DiaryEntryDto = z.infer<typeof diaryEntrySchema>;
export type DiaryListQuery = z.infer<typeof diaryListQuerySchema>;
export type DiaryListDto = {
  entries: DiaryEntryDto[];
};
export type DiaryGetQuery = z.infer<typeof diaryGetQuerySchema>;
export type CompanionEventType = z.infer<typeof companionEventTypeSchema>;
export type CompanionEventRecordRequest = z.infer<
  typeof companionEventRecordRequestSchema
>;
export type CompanionEventRecordResponse = z.infer<
  typeof companionEventRecordResponseSchema
>;
export type CompanionProfileSummaryDto = z.infer<
  typeof companionProfileSummarySchema
>;
export type ExplicitMemoryRememberRequest = z.infer<
  typeof explicitMemoryRememberRequestSchema
>;
export type ExplicitMemoryRememberResponse = z.infer<
  typeof explicitMemoryRememberResponseSchema
>;
