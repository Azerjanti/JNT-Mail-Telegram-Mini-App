import app from "./app";
import { ensureTables } from "./lib/database";
import { logger } from "./lib/logger";
import { startTelegramPolling } from "./lib/telegram-bot";
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
  await ensureTables();
  await resumePendingAnnouncements();

  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Server listening");
  });
  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });

  startTelegramPolling();
}

void startServer().catch((err: unknown) => {
  logger.error({ err }, "API server startup failed");
  process.exit(1);
});
