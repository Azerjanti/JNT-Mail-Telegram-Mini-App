import { bigserial, bigint, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const mailSessions = pgTable("mail_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull().references(() => users.telegramId, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  mailCount: integer("mail_count").notNull().default(0),
  lastMailAt: timestamp("last_mail_at", { withTimezone: true }),
}, (table) => [
  index("mail_sessions_expires_idx").on(table.expiresAt),
  index("mail_sessions_user_created_idx").on(table.telegramId, table.createdAt.desc()),
  index("mail_sessions_mail_idx").on(table.mailCount, table.lastMailAt.desc()),
]);