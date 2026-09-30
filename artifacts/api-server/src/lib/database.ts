import { pool } from "@workspace/db";

let ensured = false;
let ensurePromise: Promise<void> | null = null;

export async function ensureTables(): Promise<void> {
  if (ensured) return;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        language TEXT NOT NULL DEFAULT 'en',
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        login_count INTEGER NOT NULL DEFAULT 0,
        last_login_counted_at TIMESTAMPTZ,
        banned BOOLEAN NOT NULL DEFAULT FALSE,
        ban_reason TEXT,
        banned_at TIMESTAMPTZ,
        bot_blocked BOOLEAN NOT NULL DEFAULT FALSE
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_counted_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS mail_sessions (
        id BIGSERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        mail_count INTEGER NOT NULL DEFAULT 0,
        last_mail_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS mail_sessions_expires_idx ON mail_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS mail_sessions_user_created_idx ON mail_sessions(telegram_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS mail_sessions_mail_idx ON mail_sessions(mail_count, last_mail_at DESC);

      CREATE TABLE IF NOT EXISTS channels (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        username TEXT,
        title TEXT NOT NULL,
        invite_link TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_check_error TEXT
      );
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_check_error TEXT;

      CREATE TABLE IF NOT EXISTS announcements (
        id BIGSERIAL PRIMARY KEY,
        text TEXT NOT NULL DEFAULT '',
        parse_html BOOLEAN NOT NULL DEFAULT FALSE,
        media JSONB NOT NULL DEFAULT '[]'::jsonb,
        button_text TEXT,
        button_url TEXT,
        target_lang TEXT NOT NULL DEFAULT 'all',
        status TEXT NOT NULL DEFAULT 'draft',
        total INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        last_user_id BIGINT NOT NULL DEFAULT 0,
        target_max_user_id BIGINT NOT NULL DEFAULT 0,
        created_by BIGINT
      );
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS last_user_id BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_max_user_id BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by BIGINT;
      CREATE INDEX IF NOT EXISTS announcements_status_idx ON announcements(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS ads (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        link_url TEXT NOT NULL,
        button_text TEXT NOT NULL DEFAULT '',
        image BYTEA,
        image_mime TEXT,
        logo BYTEA,
        logo_mime TEXT,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        views BIGINT NOT NULL DEFAULT 0,
        clicks BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ads_active_idx ON ads(active);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(telegram_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS announcement_deliveries (
        announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        telegram_id BIGINT NOT NULL,
        result TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (announcement_id, telegram_id)
      );
    `);
    ensured = true;
  })();

  try {
    await ensurePromise;
  } finally {
    ensurePromise = null;
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
