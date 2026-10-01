import app from "./app";
import { logger } from "./lib/logger";
import { getAdminIds, parseAdminIds } from "./lib/telegram-auth";
import { startTelegramWebhook } from "./lib/telegram-bot";
import { resumePendingAnnouncements } from "./routes/admin";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer(): Promise<void> {
  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Server listening");
    const adminIdsFromEnv = parseAdminIds(process.env["ADMIN_IDS"]).length;
    logger.info({ adminCount: getAdminIds().size, adminIdsFromEnv }, "Admin access configured");
    if (process.env["ADMIN_IDS"]?.trim() && adminIdsFromEnv === 0) {
      logger.warn("ADMIN_IDS is set but contains no valid Telegram IDs; only the built-in admin is active");
    }
    void resumePendingAnnouncements().catch((err: unknown) => {
      logger.error({ err }, "Could not resume pending announcements");
    });
    void startTelegramWebhook().catch((err: unknown) => {
      logger.error({ err }, "Could not initialize Telegram webhook");
    });
  });
  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });
}

void startServer().catch((err: unknown) => {
  logger.error({ err }, "API server startup failed");
  process.exit(1);
});
