import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getAdminUser, writeAuditLog } from "../lib/admin";
import { operationsSummary } from "../lib/operations-status";
import { jaiSummary, setJaiAdminEnabled } from "./jai";

const router: IRouter = Router();

router.get("/summary", async (_req, res) => {
  const admin = getAdminUser(res);
  try {
    const [totals, recentUsers, activeUsers, mailUsers, providerDistribution] = await Promise.all([
      pool.query<{
        total_users: string;
        total_sessions: string;
        active_sessions: string;
        new_users_today: string;
        banned_users: string;
      }>(`
        SELECT
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(*) FROM mail_sessions) AS total_sessions,
          (SELECT COUNT(*) FROM mail_sessions WHERE expires_at > NOW()) AS active_sessions,
          (SELECT COUNT(*) FROM users WHERE first_seen >= DATE_TRUNC('day', NOW())) AS new_users_today,
          (SELECT COUNT(*) FROM users WHERE banned = TRUE) AS banned_users
      `),
      pool.query<{
        telegram_id: string;
        username: string | null;
        first_name: string | null;
        language: string;
        last_seen: Date;
      }>(`
        SELECT telegram_id::text, username, first_name, language, last_seen
        FROM users ORDER BY last_seen DESC LIMIT 15
      `),
      pool.query<{
        telegram_id: string;
        username: string | null;
        first_name: string | null;
        language: string;
        expires_at: Date;
        session_created_at: Date;
        remaining_seconds: number;
      }>(`
        SELECT latest.* FROM (
          SELECT DISTINCT ON (u.telegram_id)
            u.telegram_id::text, u.username, u.first_name, u.language,
            ms.expires_at, ms.created_at AS session_created_at,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ms.expires_at - NOW()))))::int AS remaining_seconds
          FROM mail_sessions ms
          JOIN users u ON u.telegram_id = ms.telegram_id
          WHERE ms.expires_at > NOW()
          ORDER BY u.telegram_id, ms.created_at DESC
        ) latest
        ORDER BY latest.session_created_at DESC LIMIT 3
      `),
      pool.query<{
        telegram_id: string;
        username: string | null;
        first_name: string | null;
        language: string;
        mail_count: string;
        last_mail_at: Date;
      }>(`
        SELECT u.telegram_id::text, u.username, u.first_name, u.language,
          SUM(ms.mail_count)::text AS mail_count, MAX(ms.last_mail_at) AS last_mail_at
        FROM users u
        JOIN mail_sessions ms ON ms.telegram_id = u.telegram_id
        WHERE ms.mail_count > 0 AND ms.last_mail_at IS NOT NULL
        GROUP BY u.telegram_id, u.username, u.first_name, u.language
        ORDER BY MAX(ms.last_mail_at) DESC LIMIT 10
      `),
      pool.query<{ provider: string; count: string }>(`
        SELECT provider, COUNT(*)::text AS count
        FROM mail_sessions GROUP BY provider ORDER BY COUNT(*) DESC
      `),
    ]);

    const totalsRow = totals.rows[0] ?? {
      total_users: "0",
      total_sessions: "0",
      active_sessions: "0",
      new_users_today: "0",
      banned_users: "0",
    };
    const recent = recentUsers.rows.map((user) => ({
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      language: user.language,
      lastSeen: user.last_seen,
    }));
    const active = activeUsers.rows
      .sort((left, right) => new Date(right.session_created_at).getTime() - new Date(left.session_created_at).getTime())
      .slice(0, 3)
      .map((user) => ({
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        language: user.language,
        expiresAt: user.expires_at,
        remainingSeconds: user.remaining_seconds,
      }));
    const mail = mailUsers.rows.map((user) => ({
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      language: user.language,
      mailCount: Number(user.mail_count),
      lastMailAt: user.last_mail_at,
    }));

    await writeAuditLog(admin.id, "admin.summary.view", {});
    res.json({
      totals: {
        totalUsers: Number(totalsRow.total_users),
        totalSessions: Number(totalsRow.total_sessions),
        activeSessions: Number(totalsRow.active_sessions),
        newUsersToday: Number(totalsRow.new_users_today),
        bannedUsers: Number(totalsRow.banned_users),
      },
      recentUsers: recent,
      activeUsers: active,
      mailUsers: mail,
      operations: {
        ...operationsSummary(),
        distribution: providerDistribution.rows.map((item) => ({ provider: item.provider, count: Number(item.count) })),
      },
      jai: jaiSummary(),
    });
  } catch (caught) {
    res.status(500).json({ error: "summary_failed" });
  }
});

router.put("/summary/jai", async (req, res) => {
  const admin = getAdminUser(res);
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "invalid_enabled" });
  try {
    await pool.query(
      `INSERT INTO settings (key,value) VALUES ('jai_enabled',$1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [String(req.body.enabled)],
    );
    setJaiAdminEnabled(req.body.enabled);
    await writeAuditLog(admin.id, "admin.jai.toggle", { enabled: req.body.enabled });
    return res.json({ enabled: req.body.enabled });
  } catch {
    return res.status(500).json({ error: "jai_toggle_failed" });
  }
});

export default router;
