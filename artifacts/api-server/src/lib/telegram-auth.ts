import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export type TelegramLanguage = "tr" | "ru" | "en";

export type TelegramUser = {
  id: string;
  language: TelegramLanguage;
  username?: string;
  firstName?: string;
};

const MAX_INIT_DATA_AGE_SECONDS = 60 * 60;
const PREVIEW_USER_ID = "preview-user";

export function safeLanguage(value: string | undefined): TelegramLanguage {
  return value === "tr" || value === "ru" ? value : "en";
}

export function getInitDataFromRequest(req: Request): string | null {
  const value = req.header("authorization");
  if (!value?.startsWith("tma ")) return null;
  const initData = value.slice(4).trim();
  return initData || null;
}

function decodeInitData(initData: string): Map<string, string> | null {
  try {
    const params = new URLSearchParams(initData);
    const entries = [...params.entries()];
    if (!entries.length || new Set(entries.map(([key]) => key)).size !== entries.length) return null;
    return new Map(entries);
  } catch {
    return null;
  }
}

export function verifyTelegramInitData(
  initData: string,
  maxAgeSeconds = MAX_INIT_DATA_AGE_SECONDS,
): TelegramUser | null {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken || !initData) return null;

  const fields = decodeInitData(initData);
  if (!fields) return null;
  const hash = fields.get("hash");
  const authDate = Number(fields.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (
    !hash ||
    !/^[a-f\d]{64}$/i.test(hash) ||
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    now - authDate > maxAgeSeconds ||
    authDate > now + 60
  ) {
    return null;
  }

  fields.delete("hash");
  const checkString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(checkString).digest();
  const receivedHash = Buffer.from(hash, "hex");
  if (receivedHash.length !== expectedHash.length || !timingSafeEqual(receivedHash, expectedHash)) {
    return null;
  }

  try {
    const rawUser = JSON.parse(fields.get("user") ?? "null") as {
      id?: number | string;
      username?: string;
      first_name?: string;
      language_code?: string;
    } | null;
    if (!rawUser?.id) return null;
    const id = String(rawUser.id);
    if (!/^\d{1,20}$/.test(id) || BigInt(id) <= 0n) return null;
    return {
      id,
      language: safeLanguage(rawUser.language_code),
      ...(typeof rawUser.username === "string" ? { username: rawUser.username.slice(0, 64) } : {}),
      ...(typeof rawUser.first_name === "string" ? { firstName: rawUser.first_name.slice(0, 128) } : {}),
    };
  } catch {
    return null;
  }
}

function previewUserFromInitData(initData: string | null): TelegramUser | null {
  if (process.env.NODE_ENV === "production") return null;
  if (initData) {
    const fields = decodeInitData(initData);
    try {
      const rawUser = JSON.parse(fields?.get("user") ?? "null") as {
        id?: number | string;
        username?: string;
        first_name?: string;
        language_code?: string;
      } | null;
      if (rawUser?.id && /^\d{1,20}$/.test(String(rawUser.id))) {
        return {
          id: String(rawUser.id),
          language: safeLanguage(rawUser.language_code),
          ...(typeof rawUser.username === "string" ? { username: rawUser.username.slice(0, 64) } : {}),
          ...(typeof rawUser.first_name === "string" ? { firstName: rawUser.first_name.slice(0, 128) } : {}),
        };
      }
    } catch {
      // The local preview deliberately keeps the old unsigned preview fallback.
    }
  }
  return { id: PREVIEW_USER_ID, language: "en" };
}

export function getTelegramUserFromRequest(
  req: Request,
  allowDevelopmentPreview = true,
): TelegramUser | null {
  const initData = getInitDataFromRequest(req);
  const verified = initData ? verifyTelegramInitData(initData) : null;
  if (verified) return verified;
  return allowDevelopmentPreview ? previewUserFromInitData(initData) : null;
}

export function isPreviewUser(userId: string): boolean {
  return userId === PREVIEW_USER_ID;
}

// Telegram accounts that always have admin access, even when the ADMIN_IDS
// environment variable is missing, malformed, or was added after the last
// publish. A Telegram ID is not a secret: it only grants access together with
// a signed initData payload that has been verified with BOT_TOKEN.
const BUILT_IN_ADMIN_IDS: readonly string[] = ["8377297659"];

/**
 * Parses an ADMIN_IDS style list. Commas, semicolons, spaces and new lines all
 * work as separators and quotes/brackets around a value are ignored, so
 * `8377297659`, `"8377297659"`, `[8377297659, 123]`, `8377297659 123` and a
 * pasted `ADMIN_IDS=8377297659` are all understood. Anything that is not a
 * positive integer is dropped.
 */
export function parseAdminIds(raw: string | undefined): string[] {
  const ids: string[] = [];
  for (const token of (raw ?? "").split(/[\s,;]+/)) {
    const value = token
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "")
      .replace(/^["'`\[\]{}()]+|["'`\[\]{}()]+$/g, "");
    if (!/^\d{1,20}$/.test(value)) continue;
    const normalized = BigInt(value).toString();
    if (normalized !== "0") ids.push(normalized);
  }
  return ids;
}

export function getAdminIds(): Set<string> {
  return new Set([...BUILT_IN_ADMIN_IDS, ...parseAdminIds(process.env.ADMIN_IDS)]);
}

export function isAdminId(userId: string): boolean {
  return getAdminIds().has(userId);
}
