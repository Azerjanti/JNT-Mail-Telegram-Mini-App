import { pool } from "@workspace/db";

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