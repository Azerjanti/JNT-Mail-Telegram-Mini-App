import { pool } from "@workspace/db";
import { ensureJaiConversationTable } from "./jai-conversations";

export async function ensureTables(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS jai_usage (
    telegram_id bigint PRIMARY KEY,
    window_start timestamptz NOT NULL,
    used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
  )`);
  await ensureJaiConversationTable(pool);
  const setting = await pool.query<{ value: string }>("SELECT value FROM settings WHERE key='jai_enabled'");
  if (setting.rows[0]) {
    const { setJaiAdminEnabled } = await import("../routes/jai");
    setJaiAdminEnabled(setting.rows[0].value === "true");
  }
}

export async function upsertTelegramUser(user: {
  id: string;
  username?: string;
  firstName?: string;
  language: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO users (
       telegram_id, username, first_name, language, first_seen, last_seen,
       login_count, last_login_counted_at
     ) VALUES ($1, $2, $3, $4, NOW(), NOW(), 1, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, users.username),
       first_name = COALESCE(EXCLUDED.first_name, users.first_name),
       language = EXCLUDED.language,
       login_count = users.login_count + CASE
         WHEN users.last_login_counted_at IS NULL
           OR users.last_login_counted_at <= NOW() - INTERVAL '30 minutes'
         THEN 1 ELSE 0 END,
       last_login_counted_at = CASE
         WHEN users.last_login_counted_at IS NULL
           OR users.last_login_counted_at <= NOW() - INTERVAL '30 minutes'
         THEN NOW() ELSE users.last_login_counted_at END,
       last_seen = NOW()`,
    [user.id, user.username ?? null, user.firstName ?? null, user.language],
  );
}