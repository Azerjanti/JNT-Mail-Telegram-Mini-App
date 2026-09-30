import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getAdminUser, parseTelegramId, writeAuditLog } from "../lib/admin";

const router: IRouter = Router();

router.get("/bans", async (_req, res) => {
  const admin = getAdminUser(res);
  try {
    const result = await pool.query<{
      telegram_id: string;
      username: string | null;
      first_name: string | null;
      language: string;
      ban_reason: string | null;
      banned_at: Date | null;
    }>(`
      SELECT telegram_id::text, username, first_name, language, ban_reason, banned_at
      FROM users WHERE banned = TRUE ORDER BY banned_at DESC NULLS LAST LIMIT 250
    `);
    await writeAuditLog(admin.id, "admin.bans.view", {});
    res.json({
      users: result.rows.map((user) => ({
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        language: user.language,
        reason: user.ban_reason,
        bannedAt: user.banned_at,
      })),
    });
  } catch {
    res.status(500).json({ error: "bans_failed" });
  }
});

router.post("/bans", async (req, res) => {
  const admin = getAdminUser(res);
  const telegramId = parseTelegramId(req.body?.telegramId);
  const reason = req.body?.reason === undefined || req.body?.reason === "" ? null : req.body?.reason;
  if (!telegramId || (reason !== null && (typeof reason !== "string" || reason.length > 300))) {
    res.status(400).json({ error: "ban_input_invalid" });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO users (telegram_id, language, first_seen, last_seen, login_count, banned, ban_reason, banned_at)
       VALUES ($1, 'en', NOW(), NOW(), 0, TRUE, $2, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET
         banned = TRUE, ban_reason = EXCLUDED.ban_reason, banned_at = NOW()`,
      [telegramId, reason],
    );
    await writeAuditLog(admin.id, "admin.user.ban", { telegramId, hasReason: Boolean(reason) });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "ban_failed" });
  }
});

router.delete("/bans/:telegramId", async (req, res) => {
  const admin = getAdminUser(res);
  const telegramId = parseTelegramId(req.params.telegramId);
  if (!telegramId) {
    res.status(400).json({ error: "telegram_id_invalid" });
    return;
  }
  try {
    const result = await pool.query(
      "UPDATE users SET banned = FALSE, ban_reason = NULL, banned_at = NULL WHERE telegram_id = $1 AND banned = TRUE",
      [telegramId],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "banned_user_not_found" });
      return;
    }
    await writeAuditLog(admin.id, "admin.user.unban", { telegramId });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "unban_failed" });
  }
});

export default router;
