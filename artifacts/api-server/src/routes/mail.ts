import { createHash, randomBytes } from "node:crypto";
import { Router, type IRouter, type Response as ExpressResponse } from "express";
import { InlineKeyboard, webhookCallback } from "grammy";
import {
  CreateMailSessionResponse,
  GetMailInboxResponse,
  GetMailMessageParams,
  GetMailMessageResponse,
  GetMailSessionResponse,
  RefreshMailSessionResponse,
  UpdateMailLanguageBody,
  UpdateMailLanguageResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";
import { upsertTelegramUser } from "../lib/database";
import { writeAuditLog } from "../lib/admin";
import { isAdminId, isPreviewUser, safeLanguage, type TelegramUser } from "../lib/telegram-auth";
import { telegramAppUrl, telegramBot, telegramWebhookSecret } from "../lib/telegram-bot";

type Language = "tr" | "ru" | "en";
type Provider = "mail.tm" | "mail.gw";

type MailMessage = {
  id: string;
  sender: string;
  senderEmail?: string;
  subject: string;
  preview?: string;
  receivedAt: Date;
  isRead: boolean;
  verificationCode: string | null;
  html: string | null;
  text: string | null;
};

type MailSession = {
  userId: string;
  language: Language;
  provider: Provider;
  apiBase: string;
  accountId: string;
  address: string;
  password: string;
  token: string;
  expiresAt: number;
  refreshesUsed: number;
  lastInboxCheck: number;
  messages: MailMessage[];
  notifiedMessageIds: Set<string>;
  createdAt: number;
  databaseId: string | null;
  inboxFetchPromise?: Promise<MailMessage[]>;
};

type ProviderSession = {
  provider: Provider;
  apiBase: string;
  accountId: string;
  address: string;
  password: string;
  token: string;
};

const router: IRouter = Router();
const sessions = new Map<string, MailSession>();
const newAddressEvents = new Map<string, number[]>();
const SESSION_MS = 10 * 60 * 1000;
const MAX_REFRESHES = 3;
const MIN_INBOX_CHECK_MS = 4_000;
const providers: Array<{ provider: Provider; apiBase: string }> = [
  { provider: "mail.tm", apiBase: "https://api.mail.tm" },
  { provider: "mail.gw", apiBase: "https://api.mail.gw" },
];

// Long polling is started once, after the persistent tables have been ensured
// by the server bootstrap. The API client remains available for admin actions.
const bot = telegramBot;
const appUrl = telegramAppUrl();
const adminPanelUrl = appUrl ? `${appUrl}/admin` : "";

// The admin panel is Turkish-only, so its bot copy is not localized.
const adminCopy = {
  title: "Yönetim paneli",
  open: "Paneli aç",
  missingAppUrl: "Yönetim paneli açılamadı: APP_URL ayarlı değil.",
};

const copy: Record<Language, { welcome: string; button: string; newMail: string }> = {
  tr: {
    welcome: "Tek kullanımlık e-posta adresin hazır. Başlamak için aşağıdaki butona dokun.",
    button: "Geçici Mail Aç",
    newMail: "Yeni e-posta geldi",
  },
  ru: {
    welcome: "Твой одноразовый адрес готов. Нажми кнопку ниже, чтобы начать.",
    button: "Открыть почту",
    newMail: "Новое письмо",
  },
  en: {
    welcome: "Your disposable email is ready. Tap the button below to get started.",
    button: "Open Temp Mail",
    newMail: "New email received",
  },
};

function getTelegramUser(res: ExpressResponse): TelegramUser | null {
  return (res.locals.telegramUser as TelegramUser | undefined) ?? null;
}

function error(res: ExpressResponse, status: number, message: string) {
  res.status(status).json({ error: message });
}

function codeFromMessage(subject: string, text: string, html: string): string | null {
  const content = `${subject}\n${text}\n${html}`;
  const matches = content.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [];
  return matches.find((candidate) => !/^(19|20)\d{2}$/.test(candidate)) ?? null;
}

function sanitizeHtml(value: string | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/<\s*(script|iframe|form|object|embed|base|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|form|object|embed|base|link|meta)[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "")
    .replace(/\s+(src|href)\s*=\s*(['"])\s*(?!(?:https?:|mailto:|#|data:image\/))[\s\S]*?\2/gi, "")
    .replace(/\s+(src|href)\s*=\s*(['"])\s*https?:[\s\S]*?\2/gi, (match, attribute, quote) =>
      attribute.toLowerCase() === "href" ? match : "",
    );
}

function toMessage(raw: Record<string, unknown>, isRead = false): MailMessage {
  const from =
    typeof raw.from === "object" && raw.from
      ? (raw.from as { name?: string; address?: string })
      : { name: "Unknown sender", address: "" };
  const text = typeof raw.text === "string" ? raw.text : "";
  const htmlValue = Array.isArray(raw.html)
    ? raw.html.find((part): part is string => typeof part === "string") ?? ""
    : typeof raw.html === "string"
      ? raw.html
      : "";
  const html = sanitizeHtml(htmlValue);
  const subject = typeof raw.subject === "string" && raw.subject.trim() ? raw.subject : "No subject";
  const sender = from.name?.trim() || from.address?.split("@")[0] || "Unknown sender";
  return {
    id: String(raw.id ?? createHash("sha1").update(JSON.stringify([from.address, subject, raw.createdAt, raw.intro, text])).digest("hex")),
    sender,
    senderEmail: from.address,
    subject,
    preview: text.replace(/\s+/g, " ").trim().slice(0, 140) || undefined,
    receivedAt: new Date(String(raw.createdAt ?? Date.now())),
    isRead,
    verificationCode: codeFromMessage(subject, text, htmlValue),
    html,
    text: text || null,
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function providerFetch(
  apiBase: string,
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (response.status === 429 && attempt < 3) {
    await sleep(300 * 2 ** attempt);
    return providerFetch(apiBase, path, init, attempt + 1);
  }
  return response;
}

async function createProviderSession(): Promise<ProviderSession> {
  let lastError = "Mail provider unavailable";
  for (const { provider, apiBase } of providers) {
    try {
      const domainsResponse = await providerFetch(apiBase, "/domains?page=1");
      if (!domainsResponse.ok) throw new Error(`domains ${domainsResponse.status}`);
      const domains = (await domainsResponse.json()) as { "hydra:member"?: Array<{ domain?: string }>; member?: Array<{ domain?: string }> };
      const domain = (domains["hydra:member"] ?? domains.member ?? []).find((item) => item.domain)?.domain;
      if (!domain) throw new Error("No mail domain returned");

      const localPart = `jnt${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
      const address = `${localPart}@${domain}`;
      const password = `${randomBytes(18).toString("base64url")}Jnt!9`;
      const accountResponse = await providerFetch(apiBase, "/accounts", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      if (!accountResponse.ok) throw new Error(`account ${accountResponse.status}`);
      const account = (await accountResponse.json()) as { id?: string };
      const tokenResponse = await providerFetch(apiBase, "/token", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      if (!tokenResponse.ok) throw new Error(`token ${tokenResponse.status}`);
      const token = (await tokenResponse.json()) as { token?: string };
      if (!account.id || !token.token) throw new Error("Incomplete provider response");
      return { provider, apiBase, accountId: account.id, address, password, token: token.token };
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : lastError;
      logger.warn({ provider, err: lastError }, "Mail provider attempt failed");
    }
  }
  throw new Error(lastError);
}

async function deleteProviderSession(session: MailSession) {
  try {
    await providerFetch(`${session.apiBase}`, `/accounts/${encodeURIComponent(session.accountId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.token}` },
    });
  } catch (caught) {
    logger.warn({ err: caught }, "Could not delete expired mail provider account");
  }
}

function publicSession(session: MailSession) {
  return {
    address: session.address,
    expiresAt: new Date(session.expiresAt),
    refreshesUsed: session.refreshesUsed,
    refreshesLimit: MAX_REFRESHES,
    language: session.language,
  };
}

function enforceNewAddressRateLimit(userId: string) {
  const now = Date.now();
  const recent = (newAddressEvents.get(userId) ?? []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 10) return false;
  recent.push(now);
  newAddressEvents.set(userId, recent);
  return true;
}

async function createSessionForUser(user: TelegramUser, previous?: MailSession) {
  if (!enforceNewAddressRateLimit(user.id)) throw new Error("rate_limited");
  if (previous) {
    await deleteProviderSession(previous);
    if (previous.databaseId) {
      await pool.query("UPDATE mail_sessions SET expires_at = NOW() WHERE id = $1", [previous.databaseId]);
    }
    sessions.delete(user.id);
  }
  const providerSession = await createProviderSession();
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_MS;
  let databaseId: string | null = null;
  const session: MailSession = {
    userId: user.id,
    language: user.language,
    ...providerSession,
    expiresAt,
    refreshesUsed: 0,
    lastInboxCheck: 0,
    messages: [],
    notifiedMessageIds: new Set(),
    createdAt,
    databaseId: null,
  };

  if (!isPreviewUser(user.id)) {
    try {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO mail_sessions (telegram_id, provider, created_at, expires_at, mail_count)
         VALUES ($1, $2, $3, $4, 0) RETURNING id::text`,
        [user.id, session.provider, new Date(createdAt), new Date(expiresAt)],
      );
      databaseId = result.rows[0]?.id ?? null;
      if (!databaseId) throw new Error("Mail session statistics row was not created");
    } catch (caught) {
      await deleteProviderSession(session);
      throw caught;
    }
  }

  session.databaseId = databaseId;
  sessions.set(user.id, session);
  return session;
}

async function fetchInbox(session: MailSession, userId: string): Promise<MailMessage[]> {
  if (session.inboxFetchPromise) return session.inboxFetchPromise;
  if (Date.now() - session.lastInboxCheck < MIN_INBOX_CHECK_MS) return session.messages;

  const operation = (async () => {
    session.lastInboxCheck = Date.now();
    const response = await providerFetch(session.apiBase, "/messages?page=1", {
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) throw new Error(`Inbox provider error ${response.status}`);
    const data = (await response.json()) as { "hydra:member"?: Array<Record<string, unknown>>; member?: Array<Record<string, unknown>> };
    const previousById = new Map(session.messages.map((message) => [message.id, message]));
    const previousIds = new Set(previousById.keys());
    const incoming = (data["hydra:member"] ?? data.member ?? []).map((item) => {
      const parsed = toMessage(item);
      return { ...parsed, isRead: previousById.get(parsed.id)?.isRead ?? false };
    }).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const seenInResponse = new Set<string>();
    const newMessages = incoming.filter((message) => {
      if (previousIds.has(message.id) || seenInResponse.has(message.id)) return false;
      seenInResponse.add(message.id);
      return true;
    });

    if (newMessages.length > 0 && session.databaseId) {
      const lastMailAt = new Date(Math.max(...newMessages.map((message) => message.receivedAt.getTime())));
      await pool.query(
        `UPDATE mail_sessions SET mail_count = mail_count + $2,
          last_mail_at = GREATEST(COALESCE(last_mail_at, $3), $3)
         WHERE id = $1`,
        [session.databaseId, newMessages.length, lastMailAt],
      );
    }

    session.messages = incoming;
    for (const message of newMessages) {
      if (!session.notifiedMessageIds.has(message.id)) {
        session.notifiedMessageIds.add(message.id);
        await notifyNewMail(userId, session.language, message);
      }
    }
    return session.messages;
  })();

  session.inboxFetchPromise = operation;
  try {
    return await operation;
  } finally {
    if (session.inboxFetchPromise === operation) session.inboxFetchPromise = undefined;
  }
}

async function fetchMessageDetail(session: MailSession, messageId: string) {
  const response = await providerFetch(session.apiBase, `/messages/${encodeURIComponent(messageId)}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!response.ok) return null;
  const raw = (await response.json()) as Record<string, unknown>;
  const message = toMessage(raw, true);
  session.messages = session.messages.map((item) => (item.id === message.id ? message : item));
  return message;
}

async function notifyNewMail(userId: string, language: Language, message: MailMessage) {
  if (!bot || isPreviewUser(userId)) return;
  try {
    const userState = await pool.query<{ banned: boolean }>("SELECT banned FROM users WHERE telegram_id = $1", [userId]);
    if (userState.rows[0]?.banned) return;
    const keyboard = appUrl ? new InlineKeyboard().webApp(copy[language].button, appUrl) : undefined;
    await bot.api.sendMessage(
      userId,
      `${copy[language].newMail}\n${message.sender}\n${message.subject}`,
      keyboard ? { reply_markup: keyboard } : {},
    );
  } catch (caught) {
    logger.warn({ userId, err: caught }, "Could not send new mail notification");
  }
}

router.get("/mail/session", async (req, res) => {
  const user = getTelegramUser(res);
  if (!user) return error(res, 401, "Unauthorized");
  try {
    const existing = sessions.get(user.id);
    if (existing && existing.expiresAt > Date.now()) return res.json(GetMailSessionResponse.parse(publicSession(existing)));
    const session = await createSessionForUser(user, existing);
    return res.json(GetMailSessionResponse.parse(publicSession(session)));
  } catch (caught) {
    if (caught instanceof Error && caught.message === "rate_limited") return error(res, 429, "Too many new addresses");
    logger.error({ userId: user.id, err: caught }, "Could not create mail session");
    return error(res, 502, "Mail provider unavailable");
  }
});

router.post("/mail/session", async (req, res) => {
  const user = getTelegramUser(res);
  if (!user) return error(res, 401, "Unauthorized");
  try {
    const session = await createSessionForUser(user, sessions.get(user.id));
    return res.status(201).json(CreateMailSessionResponse.parse(publicSession(session)));
  } catch (caught) {
    if (caught instanceof Error && caught.message === "rate_limited") return error(res, 429, "Too many new addresses");
    logger.error({ userId: user.id, err: caught }, "Could not replace mail session");
    return error(res, 502, "Mail provider unavailable");
  }
});

router.post("/mail/session/refresh", async (req, res) => {
  const user = getTelegramUser(res);
  if (!user) return error(res, 401, "Unauthorized");
  const session = sessions.get(user.id);
  if (!session || session.expiresAt <= Date.now()) return error(res, 404, "Session expired");
  if (session.refreshesUsed >= MAX_REFRESHES) return error(res, 409, "Refresh limit reached");
  session.refreshesUsed += 1;
  session.expiresAt = Date.now() + SESSION_MS;
  if (session.databaseId) {
    await pool.query("UPDATE mail_sessions SET expires_at = $2 WHERE id = $1", [session.databaseId, new Date(session.expiresAt)]);
  }
  return res.json(RefreshMailSessionResponse.parse(publicSession(session)));
});

router.post("/mail/session/language", async (req, res) => {
  const user = getTelegramUser(res);
  if (!user) return error(res, 401, "Unauthorized");
  const parsed = UpdateMailLanguageBody.safeParse(req.body);
  if (!parsed.success) return error(res, 400, "Invalid language");
  const session = sessions.get(user.id);
  if (!session) return error(res, 404, "Session not found");
  session.language = parsed.data.language;
  return res.json(UpdateMailLanguageResponse.parse(publicSession(session)));
});

router.get("/mail/inbox", async (req, res) => {
  const user = getTelegramUser(res);
  if (!user) return error(res, 401, "Unauthorized");
  const session = sessions.get(user.id);
  if (!session || session.expiresAt <= Date.now()) return error(res, 404, "Session expired");
  try {
    const messages = await fetchInbox(session, user.id);
    const payload = { messages, unreadCount: messages.filter((message) => !message.isRead).length, checkedAt: new Date() };
    return res.json(GetMailInboxResponse.parse(payload));
  } catch (caught) {
    logger.error({ userId: user.id, err: caught }, "Could not fetch mail inbox");
    return error(res, 502, "Inbox unavailable");
  }
});

router.get("/mail/messages/:messageId", async (req, res) => {
  const user = getTelegramUser(res);
  if (!user) return error(res, 401, "Unauthorized");
  const params = GetMailMessageParams.safeParse(req.params);
  if (!params.success) return error(res, 400, "Invalid message id");
  const session = sessions.get(user.id);
  if (!session || session.expiresAt <= Date.now()) return error(res, 404, "Session expired");
  try {
    const message = await fetchMessageDetail(session, params.data.messageId);
    if (!message) return error(res, 404, "Message not found");
    return res.json(GetMailMessageResponse.parse(message));
  } catch (caught) {
    logger.error({ userId: user.id, err: caught }, "Could not fetch mail detail");
    return error(res, 502, "Message unavailable");
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      void deleteProviderSession(session);
      sessions.delete(userId);
    }
  }
}, 30_000).unref();

if (bot) {
  bot.use(async (ctx, next) => {
    const isMembershipUpdate = Object.prototype.hasOwnProperty.call(ctx.update, "my_chat_member");
    if (!isMembershipUpdate && ctx.chat?.type === "private" && ctx.from) {
      try {
        const state = await pool.query<{ banned: boolean }>(
          "SELECT banned FROM users WHERE telegram_id = $1",
          [String(ctx.from.id)],
        );
        if (state.rows[0]?.banned) return;
      } catch (caught) {
        logger.error({ telegramId: ctx.from.id, err: caught }, "Could not verify bot user ban state");
        return;
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from || ctx.chat.type !== "private") return;
    const user: TelegramUser = {
      id: String(ctx.from.id),
      language: safeLanguage(ctx.from.language_code),
      ...(ctx.from.username ? { username: ctx.from.username } : {}),
      ...(ctx.from.first_name ? { firstName: ctx.from.first_name } : {}),
    };
    try {
      await upsertTelegramUser(user);
    } catch (caught) {
      logger.error({ telegramId: user.id, err: caught }, "Could not register /start user");
      return;
    }
    const keyboard = appUrl ? new InlineKeyboard().webApp(copy[user.language].button, appUrl) : undefined;
    // Admins get a second button that opens the admin panel inside Telegram.
    if (keyboard && isAdminId(user.id)) keyboard.row().webApp(adminCopy.title, adminPanelUrl);
    await ctx.reply(copy[user.language].welcome, keyboard ? { reply_markup: keyboard } : {});
  });

  bot.command("admin", async (ctx) => {
    const telegramId = ctx.from?.id;
    // Stay silent for everyone else so the command cannot be discovered.
    if (!telegramId || ctx.chat.type !== "private" || !isAdminId(String(telegramId))) return;
    if (!appUrl) {
      await ctx.reply(adminCopy.missingAppUrl);
      return;
    }
    await writeAuditLog(String(telegramId), "bot.admin.open", {}).catch((caught) => {
      logger.warn({ telegramId, err: caught }, "Could not record admin bot command");
    });
    await ctx.reply(adminCopy.title, {
      reply_markup: new InlineKeyboard().webApp(adminCopy.open, adminPanelUrl),
    });
  });

  bot.on("my_chat_member", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const telegramId = String(ctx.chat.id);
    const user: TelegramUser = {
      id: telegramId,
      language: safeLanguage(ctx.from.language_code),
      ...(ctx.from.username ? { username: ctx.from.username } : {}),
      ...(ctx.from.first_name ? { firstName: ctx.from.first_name } : {}),
    };
    const status = ctx.myChatMember.new_chat_member.status;
    try {
      await upsertTelegramUser(user);
      if (status === "kicked" || status === "member") {
        await pool.query("UPDATE users SET bot_blocked = $2 WHERE telegram_id = $1", [telegramId, status === "kicked"]);
      }
    } catch (caught) {
      logger.error({ telegramId, err: caught }, "Could not persist Telegram bot membership update");
    }
  });

  if (process.env.NODE_ENV === "production" && telegramWebhookSecret) {
    router.post(
      "/telegram/webhook",
      webhookCallback(bot, "express", { secretToken: telegramWebhookSecret }),
    );
  }
}

export default router;
