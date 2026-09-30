import type { RequestHandler } from "express";
import { pool } from "@workspace/db";
import { getGateStatus } from "../lib/gate";
import { logger } from "../lib/logger";
import { getTelegramUserFromRequest, isAdminId, isPreviewUser } from "../lib/telegram-auth";
import { upsertTelegramUser } from "../lib/database";

export const EXEMPT = [
  "/api/healthz",
  "/api/admin",
  "/api/telegram/webhook",
  "/api/gate",
  "/api/ads/public",
  /^\/api\/ads\/[^/]+\/(?:image|logo)$/,
] as const;

export function isExemptUserGatePath(path: string): boolean {
  return EXEMPT.some((entry) => {
    if (typeof entry === "string") {
      return path === entry ||
        ((entry === "/api/admin" || entry === "/api/gate") && path.startsWith(`${entry}/`));
    }
    return entry.test(path);
  });
}

export const userGate: RequestHandler = async (req, res, next) => {
  const path = (req.originalUrl ?? req.url).split("?", 1)[0] ?? "";
  if (isExemptUserGatePath(path)) {
    next();
    return;
  }

  const user = getTelegramUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.locals.telegramUser = user;

  // Keep the existing local browser preview usable without creating a fake
  // Telegram user row or requiring a real initData signature.
  if (isPreviewUser(user.id)) {
    next();
    return;
  }

  try {
    await upsertTelegramUser(user);
    const userResult = await pool.query<{ banned: boolean }>(
      "SELECT banned FROM users WHERE telegram_id = $1",
      [user.id],
    );
    if (userResult.rows[0]?.banned) {
      res.status(403).json({ error: "banned" });
      return;
    }

    if (!isAdminId(user.id)) {
      const status = await getGateStatus(user.id);
      if (status.subscriptionRequired && !status.subscribed) {
        res.status(403).json({
          error: "subscription_required",
          channels: status.channels.filter((channel) => !channel.joined && !channel.error),
        });
        return;
      }
    }
    next();
  } catch (caught) {
    logger.error({ userId: user.id, err: caught }, "User gate could not load the user state");
    res.status(503).json({ error: "service_unavailable" });
  }
};
