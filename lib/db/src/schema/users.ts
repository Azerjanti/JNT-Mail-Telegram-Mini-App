import { bigint, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  telegramId: bigint("telegram_id", { mode: "bigint" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  language: text("language").notNull().default("en"),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  loginCount: integer("login_count").notNull().default(0),
  lastLoginCountedAt: timestamp("last_login_counted_at", { withTimezone: true }),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  botBlocked: boolean("bot_blocked").notNull().default(false),
});