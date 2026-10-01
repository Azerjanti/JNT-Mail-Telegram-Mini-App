import { createHash } from "node:crypto";
import { Bot } from "grammy";
import { logger } from "./logger";

const botToken = process.env.BOT_TOKEN;
const sessionSecret = process.env.SESSION_SECRET;

export const telegramBot = botToken ? new Bot(botToken) : null;

// Telegram sends this value back in the X-Telegram-Bot-Api-Secret-Token header, which is how the
// webhook route rejects forged updates. SESSION_SECRET is preferred. When it is missing the secret is
// derived from BOT_TOKEN instead (only the bot owner knows it), so a forgotten secret cannot silently
// switch the whole bot off in production: no webhook, no menu button, no /start, no /admin.
export const telegramWebhookSecret = sessionSecret
  ? createHash("sha256").update(`jnt-mail-telegram-webhook:${sessionSecret}`).digest("hex")
  : botToken
    ? createHash("sha256").update(`jnt-mail-telegram-webhook:bot-token:${botToken}`).digest("hex")
    : null;

export function telegramAppUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/+$/, "");
}

// Replit workspace (development) domains. They only answer while the workspace is running;
// otherwise Telegram shows Replit's "Run this app to see the results here" placeholder.
function isReplitDevelopmentUrl(url: string): boolean {
  try {
    return /\.(?:replit\.dev|repl\.co)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function startTelegramWebhook(): Promise<void> {
  if (!telegramBot || process.env.NODE_ENV !== "production") return;

  const appUrl = telegramAppUrl();
  if (!appUrl) {
    logger.error("APP_URL is missing; Telegram webhook cannot be configured");
    return;
  }
  if (isReplitDevelopmentUrl(appUrl)) {
    logger.error(
      { appUrl },
      "APP_URL is a Replit development address. Telegram will show \"Run this app to see the results here\" whenever the workspace is stopped; set APP_URL to the published .replit.app address",
    );
  }
  if (!telegramWebhookSecret) {
    logger.error("BOT_TOKEN is missing; Telegram webhook cannot be secured");
    return;
  }
  if (!process.env.SESSION_SECRET) {
    logger.warn("SESSION_SECRET is not set; the webhook secret is derived from BOT_TOKEN. Add SESSION_SECRET to the deployment secrets to use a dedicated value");
  }

  // The menu button does not depend on the webhook, so point it at the published Mini App first.
  // This overrides a stale address (for example the workspace URL) saved earlier in BotFather.
  try {
    await telegramBot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "JNT Mail", web_app: { url: appUrl } },
    });
    logger.info({ appUrl }, "Telegram menu button configured");
  } catch (err) {
    logger.error({ err, appUrl }, "Could not configure the Telegram menu button");
  }
  await telegramBot.api.setWebhook(`${appUrl}/api/telegram/webhook`, {
    secret_token: telegramWebhookSecret,
  });
  logger.info({ webhookUrl: `${appUrl}/api/telegram/webhook` }, "Telegram webhook configured");
}

telegramBot?.catch((caught) => {
  logger.error({ err: caught }, "Telegram update handler failed");
});