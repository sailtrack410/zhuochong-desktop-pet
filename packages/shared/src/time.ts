export type IsoTimestamp = string;
export type DateKey = string;

export const nowIso = (): IsoTimestamp => new Date().toISOString();

export const toDateKey = (value: Date | string): DateKey => {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
};
