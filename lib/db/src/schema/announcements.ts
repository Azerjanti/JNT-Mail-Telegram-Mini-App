import { bigserial, bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export type AnnouncementMedia = Array<{ type: "photo" | "video"; file_id: string }>;

export const announcements = pgTable("announcements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  text: text("text").notNull().default(""),
  parseHtml: boolean("parse_html").notNull().default(false),
  media: jsonb("media").$type<AnnouncementMedia>().notNull().default([]),
  buttonText: text("button_text"),
  buttonUrl: text("button_url"),
  targetLang: text("target_lang").notNull().default("all"),
  status: text("status").notNull().default("draft"),
  total: integer("total").notNull().default(0),
  sent: integer("sent").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  blocked: integer("blocked").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  lastUserId: bigint("last_user_id", { mode: "bigint" }).notNull().default(0n),
  targetMaxUserId: bigint("target_max_user_id", { mode: "bigint" }).notNull().default(0n),
  createdBy: bigint("created_by", { mode: "bigint" }),
}, (table) => [
  index("announcements_status_idx").on(table.status, table.createdAt.desc()),
]);

export const announcementDeliveries = pgTable("announcement_deliveries", {
  announcementId: bigint("announcement_id", { mode: "number" }).notNull().references(() => announcements.id, { onDelete: "cascade" }),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull(),
  result: text("result").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "announcement_deliveries_pkey", columns: [table.announcementId, table.telegramId] }),
]);