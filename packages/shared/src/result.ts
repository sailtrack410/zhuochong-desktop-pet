import type { AppError } from "./errors.js";

export type Success<T> = {
  ok: true;
  value: T;
};

export type Failure<E> = {
  ok: false;
  error: E;
};

export type Result<T, E = AppError> = Success<T> | Failure<E>;

export const ok = <T>(value: T): Success<T> => ({
  ok: true,
  value,
});

export const err = <E>(error: E): Failure<E> => ({
  ok: false,
  error,
});
