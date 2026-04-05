import { z, type ZodTypeAny } from "zod";

import { contractErrorSchema } from "./errors.js";
import { contractSourceSchema, contractVersionSchema } from "./enums.js";

export const contractMetaSchema = z.object({
  contractVersion: contractVersionSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  issuedAt: z.string().datetime(),
  source: contractSourceSchema,
});

export const createContractSuccessSchema = <TData extends ZodTypeAny>(
  dataSchema: TData,
) =>
  z.object({
    ok: z.literal(true),
    data: dataSchema,
    meta: contractMetaSchema,
  });

export const contractFailureSchema = z.object({
  ok: z.literal(false),
  error: contractErrorSchema,
  meta: contractMetaSchema,
});

export const createContractResultSchema = <TData extends ZodTypeAny>(
  dataSchema: TData,
) => z.union([createContractSuccessSchema(dataSchema), contractFailureSchema]);

export type ContractMeta = z.infer<typeof contractMetaSchema>;
export type ContractFailure = z.infer<typeof contractFailureSchema>;
export type ContractSuccess<TData> = {
  ok: true;
  data: TData;
  meta: ContractMeta;
};
export type ContractResult<TData> = ContractSuccess<TData> | ContractFailure;
