import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname } from "node:os";

const algorithm = "aes-256-gcm";
const keyLength = 32;
const ivLength = 16;
const authTagLength = 16;

const deriveKey = (): Buffer => {
  const salt = "zhuochong-desktop-pet-apikey-v1";
  return scryptSync(hostname(), salt, keyLength);
};

export const encryptApiKey = (plaintext: string): string => {
  if (!plaintext) return "";
  const key = deriveKey();
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv(algorithm, key, iv, { authTagLength });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
};

export const decryptApiKey = (encoded: string): string => {
  if (!encoded) return "";
  try {
    const key = deriveKey();
    const raw = Buffer.from(encoded, "base64");
    if (raw.length < ivLength + authTagLength) return "";
    const iv = raw.subarray(0, ivLength);
    const authTag = raw.subarray(ivLength, ivLength + authTagLength);
    const encrypted = raw.subarray(ivLength + authTagLength);
    const decipher = createDecipheriv(algorithm, key, iv, { authTagLength });
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    return "";
  }
};

export const looksLikeEncrypted = (value: string): boolean =>
  value.length > 48 && /^[A-Za-z0-9+/=]+$/.test(value);
