import { bigserial, bigint, boolean, customType, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const ads = pgTable("ads", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  title: text("title").notNull(),
  text: text("text").notNull().default(""),
  linkUrl: text("link_url").notNull(),
  buttonText: text("button_text").notNull().default(""),
  image: bytea("image"),
  imageMime: text("image_mime"),
  logo: bytea("logo"),
  logoMime: text("logo_mime"),
  active: boolean("active").notNull().default(false),
  views: bigint("views", { mode: "number" }).notNull().default(0),
  clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ads_active_idx").on(table.active),
]);