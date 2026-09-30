import type { RequestHandler, Response } from "express";
import { pool } from "@workspace/db";
import { upsertTelegramUser } from "./database";
import { logger } from "./logger";
import { getInitDataFromRequest, getAdminIds, verifyTelegramInitData, type TelegramUser } from "./telegram-auth";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const rateBuckets = new Map<string, { count: number; expiresAt: number }>();

export const adminRateLimit: RequestHandler = (req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    bucket = { count: 0, expiresAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  if (rateBuckets.size > 5_000) {
    for (const [entryKey, entry] of rateBuckets) {
      if (entry.expiresAt <= now) rateBuckets.delete(entryKey);
    }
  }
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const initData = getInitDataFromRequest(req);
  const user = initData ? verifyTelegramInitData(initData, 60 * 60) : null;
  if (!user || !getAdminIds().has(user.id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    await upsertTelegramUser(user);
    res.locals.adminUser = user;
    next();
  } catch (caught) {
    logger.error({ userId: user.id, err: caught }, "Could not register admin activity");
    res.status(503).json({ error: "service_unavailable" });
  }
};

export function getAdminUser(res: Response): TelegramUser {
  return res.locals.adminUser as TelegramUser;
}

export async function writeAuditLog(
  actorId: string,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    "INSERT INTO audit_log (telegram_id, action, details, created_at) VALUES ($1, $2, $3::jsonb, NOW())",
    [actorId, action, JSON.stringify(details)],
  );
}

export function parseTelegramId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  if (!/^\d{1,20}$/.test(id)) return null;
  try {
    if (BigInt(id) <= 0n || BigInt(id) > 9_223_372_036_854_775_807n) return null;
  } catch {
    return null;
  }
  return id;
}

export function safeErrorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message.slice(0, 500) : "İşlem tamamlanamadı";
}
