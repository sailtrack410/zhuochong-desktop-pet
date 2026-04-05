import { z, type ZodTypeAny } from "zod";

export const createCapabilityInfoSchema = <TData extends ZodTypeAny>(
  dataSchema: TData,
) =>
  z.union([
    z.object({
      state: z.literal("ok"),
      data: dataSchema,
    }),
    z.object({
      state: z.literal("unsupported"),
    }),
    z.object({
      state: z.literal("denied"),
      reason: z.string().min(1),
    }),
    z.object({
      state: z.literal("error"),
      reason: z.string().min(1),
    }),
    z.object({
      state: z.literal("disabled"),
    }),
  ]);

export type CapabilityInfo<TData> =
  | { state: "ok"; data: TData }
  | { state: "unsupported" }
  | { state: "denied"; reason: string }
  | { state: "error"; reason: string }
  | { state: "disabled" };
