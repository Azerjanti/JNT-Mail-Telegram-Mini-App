import { Bot } from "grammy";
import { logger } from "./logger";

const botToken = process.env.BOT_TOKEN;

// The API client is also used by admin operations in development; only production
// starts long polling so local runs cannot steal updates from the deployment.
export const telegramBot = botToken ? new Bot(botToken) : null;

let pollingStarted = false;

export function startTelegramPolling(): void {
  if (!telegramBot || process.env.NODE_ENV !== "production" || pollingStarted) return;
  pollingStarted = true;
  const appUrl = telegramAppUrl();
  if (appUrl) {
    void telegramBot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "JNT Mail", web_app: { url: appUrl } },
    }).catch((caught) => logger.warn({ err: caught }, "Could not set Telegram menu button"));
  } else {
    logger.warn("APP_URL is missing; Telegram web app buttons were not configured");
  }
  telegramBot.catch((caught) => logger.warn({ err: caught }, "Telegram bot error"));
  void telegramBot.start({ drop_pending_updates: true }).catch((caught) => {
    pollingStarted = false;
    logger.error({ err: caught }, "Telegram long polling stopped");
  });
}

export function telegramAppUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}
