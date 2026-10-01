import { bigserial, boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const channels = pgTable("channels", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  chatId: text("chat_id").notNull().unique("channels_chat_id_key"),
  username: text("username"),
  title: text("title").notNull(),
  inviteLink: text("invite_link"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastCheckError: text("last_check_error"),
});