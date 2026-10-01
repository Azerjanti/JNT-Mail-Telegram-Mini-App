import { createHash } from "node:crypto";
import { Bot } from "grammy";
import { logger } from "./logger";

const botToken = process.env.BOT_TOKEN;
const sessionSecret = process.env.SESSION_SECRET;

export const telegramBot = botToken ? new Bot(botToken) : null;
export const telegramWebhookSecret = sessionSecret
  ? createHash("sha256").update(`jnt-mail-telegram-webhook:${sessionSecret}`).digest("hex")
  : null;

export function telegramAppUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/+$/, "");
}

export async function startTelegramWebhook(): Promise<void> {
  if (!telegramBot || process.env.NODE_ENV !== "production") return;

  const appUrl = telegramAppUrl();
  if (!appUrl) {
    logger.error("APP_URL is missing; Telegram webhook cannot be configured");
    return;
  }
  if (!telegramWebhookSecret) {
    logger.error("SESSION_SECRET is missing; Telegram webhook cannot be secured");
    return;
  }

  await telegramBot.api.setChatMenuButton({
    menu_button: { type: "web_app", text: "JNT Mail", web_app: { url: appUrl } },
  });
  await telegramBot.api.setWebhook(`${appUrl}/api/telegram/webhook`, {
    secret_token: telegramWebhookSecret,
  });
  logger.info({ webhookUrl: `${appUrl}/api/telegram/webhook` }, "Telegram webhook configured");
}

telegramBot?.catch((caught) => {
  logger.error({ err: caught }, "Telegram update handler failed");
});