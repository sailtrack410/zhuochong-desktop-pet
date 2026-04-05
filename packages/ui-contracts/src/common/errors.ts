import { z } from "zod";

export const contractErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "UNSUPPORTED_CAPABILITY",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
]);

export const contractErrorSchema = z.object({
  code: contractErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  fieldErrors: z
    .array(
      z.object({
        field: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .optional(),
});

export type ContractErrorCode = z.infer<typeof contractErrorCodeSchema>;
export type ContractError = z.infer<typeof contractErrorSchema>;
