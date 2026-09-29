import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { Bot, InlineKeyboard } from "grammy";
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
};

type TelegramUser = {
  id: string;
  language: Language;
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
const PREVIEW_USER_ID = "preview-user";
const SESSION_MS = 10 * 60 * 1000;
const MAX_REFRESHES = 3;
const MIN_INBOX_CHECK_MS = 4_000;
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;
const providers: Array<{ provider: Provider; apiBase: string }> = [
  { provider: "mail.tm", apiBase: "https://api.mail.tm" },
  { provider: "mail.gw", apiBase: "https://api.mail.gw" },
];

// Long polling must run in exactly one production process. Keeping it off in
// the development workflow prevents Telegram's 409 getUpdates conflict when a
// published deployment is using the same bot token.
const bot = process.env.BOT_TOKEN && process.env.NODE_ENV === "production"
  ? new Bot(process.env.BOT_TOKEN)
  : null;
const appUrl = process.env.APP_URL ?? "";

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

function safeLanguage(value: string | undefined): Language {
  return value === "tr" || value === "ru" ? value : "en";
}

function headerValue(req: Request): string | null {
  const value = req.header("authorization");
  return value?.startsWith("tma ") ? value.slice(4) : null;
}

function parseTelegramInitData(initData: string): Map<string, string> {
  return new Map(
    initData
      .split("&")
      .map((part) => part.split("="))
      .filter(([key, value]) => Boolean(key && value))
      .map(([key, value]) => [decodeURIComponent(key), decodeURIComponent(value)]),
  );
}

function verifyTelegramInitData(initData: string): TelegramUser | null {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken || !initData) return null;

  const fields = parseTelegramInitData(initData);
  const hash = fields.get("hash");
  const authDate = Number(fields.get("auth_date"));
  if (!hash || !authDate || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    return null;
  }

  fields.delete("hash");
  const checkString = [...fields.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(checkString).digest("hex");
  const received = Buffer.from(hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  try {
    const user = JSON.parse(fields.get("user") ?? "{}") as { id?: number; language_code?: string };
    if (!user.id) return null;
    return { id: String(user.id), language: safeLanguage(user.language_code) };
  } catch {
    return null;
  }
}

function getTelegramUser(req: Request): TelegramUser | null {
  const initData = headerValue(req);
  const verified = initData ? verifyTelegramInitData(initData) : null;
  if (verified) return verified;

  if (process.env.NODE_ENV !== "production") {
    try {
      const previewData = initData ? parseTelegramInitData(initData) : new Map();
      const user = JSON.parse(previewData.get("user") ?? "{}") as { id?: number; language_code?: string };
      return {
        id: user.id ? String(user.id) : PREVIEW_USER_ID,
        language: safeLanguage(user.language_code),
      };
    } catch {
      return { id: PREVIEW_USER_ID, language: "en" };
    }
  }
  return null;
}

function error(res: Parameters<Parameters<IRouter["get"]>[1]>[1], status: number, message: string) {
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
    id: String(raw.id ?? createHash("sha1").update(`${sender}-${subject}-${raw.createdAt ?? Date.now()}`).digest("hex")),
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
  if (previous) await deleteProviderSession(previous);
  const providerSession = await createProviderSession();
  const session: MailSession = {
    userId: user.id,
    language: user.language,
    ...providerSession,
    expiresAt: Date.now() + SESSION_MS,
    refreshesUsed: 0,
    lastInboxCheck: 0,
    messages: [],
    notifiedMessageIds: new Set(),
    createdAt: Date.now(),
  };
  sessions.set(user.id, session);
  return session;
}

async function fetchInbox(session: MailSession, userId: string) {
  const now = Date.now();
  if (now - session.lastInboxCheck < MIN_INBOX_CHECK_MS) return session.messages;
  session.lastInboxCheck = now;
  const response = await providerFetch(session.apiBase, "/messages?page=1", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!response.ok) throw new Error(`Inbox provider error ${response.status}`);
  const data = (await response.json()) as { "hydra:member"?: Array<Record<string, unknown>>; member?: Array<Record<string, unknown>> };
  const incoming = (data["hydra:member"] ?? data.member ?? []).map((item) =>
    toMessage(item, session.messages.some((message) => message.id === String(item.id))),
  );
  const previousIds = new Set(session.messages.map((message) => message.id));
  session.messages = incoming.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const newMessages = session.messages.filter((message) => !previousIds.has(message.id));
  for (const message of newMessages) {
    if (!session.notifiedMessageIds.has(message.id)) {
      session.notifiedMessageIds.add(message.id);
      await notifyNewMail(userId, session.language, message);
    }
  }
  return session.messages;
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
  if (!bot || userId === PREVIEW_USER_ID) return;
  try {
    const keyboard = new InlineKeyboard().webApp(copy[language].button, appUrl);
    await bot.api.sendMessage(
      userId,
      `${copy[language].newMail}\n${message.sender}\n${message.subject}`,
      { reply_markup: keyboard },
    );
  } catch (caught) {
    logger.warn({ userId, err: caught }, "Could not send new mail notification");
  }
}

router.get("/mail/session", async (req, res) => {
  const user = getTelegramUser(req);
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
  const user = getTelegramUser(req);
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
  const user = getTelegramUser(req);
  if (!user) return error(res, 401, "Unauthorized");
  const session = sessions.get(user.id);
  if (!session || session.expiresAt <= Date.now()) return error(res, 404, "Session expired");
  if (session.refreshesUsed >= MAX_REFRESHES) return error(res, 409, "Refresh limit reached");
  session.refreshesUsed += 1;
  session.expiresAt = Date.now() + SESSION_MS;
  return res.json(RefreshMailSessionResponse.parse(publicSession(session)));
});

router.post("/mail/session/language", async (req, res) => {
  const user = getTelegramUser(req);
  if (!user) return error(res, 401, "Unauthorized");
  const parsed = UpdateMailLanguageBody.safeParse(req.body);
  if (!parsed.success) return error(res, 400, "Invalid language");
  const session = sessions.get(user.id);
  if (!session) return error(res, 404, "Session not found");
  session.language = parsed.data.language;
  return res.json(UpdateMailLanguageResponse.parse(publicSession(session)));
});

router.get("/mail/inbox", async (req, res) => {
  const user = getTelegramUser(req);
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
  const user = getTelegramUser(req);
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
  bot.command("start", async (ctx) => {
    const language = safeLanguage(ctx.from?.language_code);
    await ctx.reply(copy[language].welcome, {
      ...(appUrl ? { reply_markup: new InlineKeyboard().webApp(copy[language].button, appUrl) } : {}),
    });
  });
  if (appUrl) {
    void bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "JNT Mail", web_app: { url: appUrl } } }).catch((caught) => {
      logger.warn({ err: caught }, "Could not set Telegram menu button");
    });
  } else {
    logger.warn("APP_URL is missing; Telegram web app buttons were not configured");
  }
  bot.catch((caught) => logger.warn({ err: caught }, "Telegram bot error"));
  void bot.start({ drop_pending_updates: true }).catch((caught) => {
    logger.error({ err: caught }, "Telegram long polling stopped");
  });
}

export default router;