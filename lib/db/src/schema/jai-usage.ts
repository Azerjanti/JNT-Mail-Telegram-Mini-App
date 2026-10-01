import { bigint, integer, pgTable, timestamp } from "drizzle-orm/pg-core";

export const jaiUsage = pgTable("jai_usage", {
  telegramId: bigint("telegram_id", { mode: "bigint" }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  used: integer("used").notNull().default(0),
});
