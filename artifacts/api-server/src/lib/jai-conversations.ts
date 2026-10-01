import { randomUUID } from "node:crypto";

export const JAI_IDLE_MS = 13 * 60 * 1000;
// Longer than the ProxyAPI timeout plus all of its retries. A crashed worker
// must not leave a user's chat permanently locked.
const REQUEST_LEASE_MS = 150_000;

export type JaiMessage = {
  role: "user" | "assistant";
  content: string;
  showSupport?: boolean;
  at: number;
};

export type JaiConversation = {
  messages: JaiMessage[];
  lastUserMessageAt: number;
  expiresAt: string;
};

export type JaiTurn = JaiConversation & { requestId: string };

type ConversationRow = {
  messages: JaiMessage[];
  last_user_message_at: Date | string;
  expires_at: Date | string;
};

export interface JaiDatabase {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export async function ensureJaiConversationTable(
  db: JaiDatabase,
): Promise<void> {
  // Also declared in @workspace/db so the publish schema flow knows this table.
  await db.query(`CREATE TABLE IF NOT EXISTS jai_conversations (
    telegram_id bigint PRIMARY KEY,
    messages jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_user_message_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    request_id uuid,
    request_started_at timestamptz
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS jai_conversations_expires_idx
    ON jai_conversations (expires_at)`);
  await db.query("DELETE FROM jai_conversations WHERE expires_at <= NOW()");
}

function conversation(row: ConversationRow): JaiConversation {
  return {
    messages: row.messages,
    lastUserMessageAt: new Date(row.last_user_message_at).getTime(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Short-lived, user-scoped memory, shared across backend workers and restarts. */
export class JaiConversationStore {
  private db: JaiDatabase;

  constructor(db: JaiDatabase) {
    this.db = db;
  }

  async get(userId: string): Promise<JaiConversation | null> {
    // Reading/reopening a chat is not user-message activity.
    await this.db.query(
      "DELETE FROM jai_conversations WHERE telegram_id = $1 AND expires_at <= NOW()",
      [userId],
    );
    const result = await this.db.query<ConversationRow>(
      `SELECT messages, last_user_message_at, expires_at FROM jai_conversations
       WHERE telegram_id = $1 AND expires_at > NOW()`,
      [userId],
    );
    return result.rows[0] ? conversation(result.rows[0]) : null;
  }

  async beginTurn(userId: string): Promise<JaiTurn | null> {
    const requestId = randomUUID();
    // Atomically keep ALL completed turns (no message/character trimming),
    // reset an expired chat, and claim the request across backend workers.
    const result = await this.db.query<ConversationRow>(
      `INSERT INTO jai_conversations (
         telegram_id, messages, last_user_message_at, expires_at,
         request_id, request_started_at
       ) VALUES ($1, '[]'::jsonb, NOW(), NOW() + $3 * INTERVAL '1 millisecond', $2, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET
         messages = CASE WHEN jai_conversations.expires_at <= NOW()
           THEN '[]'::jsonb ELSE jai_conversations.messages END,
         last_user_message_at = NOW(),
         expires_at = NOW() + $3 * INTERVAL '1 millisecond',
         request_id = $2,
         request_started_at = NOW()
       WHERE jai_conversations.expires_at <= NOW()
          OR jai_conversations.request_id IS NULL
          OR jai_conversations.request_started_at <= NOW() - $4 * INTERVAL '1 millisecond'
       RETURNING messages, last_user_message_at, expires_at`,
      [userId, requestId, JAI_IDLE_MS, REQUEST_LEASE_MS],
    );
    return result.rows[0]
      ? { ...conversation(result.rows[0]), requestId }
      : null;
  }

  async completeTurn(
    userId: string,
    turn: JaiTurn,
    userMessage: JaiMessage,
    assistantMessage: JaiMessage,
  ): Promise<JaiConversation | null> {
    const messages = [...turn.messages, userMessage, assistantMessage];
    const result = await this.db.query<ConversationRow>(
      `UPDATE jai_conversations SET messages = $3::jsonb,
         request_id = NULL, request_started_at = NULL
       WHERE telegram_id = $1 AND request_id = $2 AND expires_at > NOW()
       RETURNING messages, last_user_message_at, expires_at`,
      [userId, turn.requestId, JSON.stringify(messages)],
    );
    // Replies never extend the timer. A late reply must not resurrect a chat
    // that was explicitly cleared or expired while the model was working.
    return result.rows[0] ? conversation(result.rows[0]) : null;
  }

  async cancelTurn(userId: string, requestId: string): Promise<void> {
    // A provider failure must not remove any previously completed messages.
    await this.db.query(
      `UPDATE jai_conversations SET request_id = NULL, request_started_at = NULL
       WHERE telegram_id = $1 AND request_id = $2`,
      [userId, requestId],
    );
  }

  async delete(userId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM jai_conversations WHERE telegram_id = $1",
      [userId],
    );
  }

  async cleanup(): Promise<void> {
    await this.db.query(
      "DELETE FROM jai_conversations WHERE expires_at <= NOW()",
    );
  }
}
