import {
  bigint,
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type JaiStoredMessage = {
  role: "user" | "assistant";
  content: string;
  showSupport?: boolean;
  at: number;
};

// Temporary chat memory only. Expired rows are excluded from reads immediately
// and deleted by JAI's cleanup job; they are never exposed in the admin panel.
export const jaiConversations = pgTable(
  "jai_conversations",
  {
    telegramId: bigint("telegram_id", { mode: "bigint" }).primaryKey(),
    messages: jsonb("messages")
      .$type<JaiStoredMessage[]>()
      .notNull()
      .default([]),
    lastUserMessageAt: timestamp("last_user_message_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requestId: uuid("request_id"),
    requestStartedAt: timestamp("request_started_at", { withTimezone: true }),
  },
  (table) => [index("jai_conversations_expires_idx").on(table.expiresAt)],
);
