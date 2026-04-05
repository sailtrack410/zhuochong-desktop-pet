export type EntityId = string;

export const createPrefixedId = (prefix: string): EntityId => {
  const entropy = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}_${entropy}`;
};
