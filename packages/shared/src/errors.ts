export const appErrorCodes = [
  "VALIDATION_ERROR",
  "CONFIG_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "UNSUPPORTED_CAPABILITY",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export type AppError = {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string>;
};

export const createAppError = (
  code: AppErrorCode,
  message: string,
  options?: {
    retryable?: boolean;
    details?: Record<string, string>;
  },
): AppError => ({
  code,
  message,
  retryable: options?.retryable ?? false,
  ...(options?.details ? { details: options.details } : {}),
});
