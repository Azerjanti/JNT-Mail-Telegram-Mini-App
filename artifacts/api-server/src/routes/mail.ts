import { Router, type IRouter, type Response as ExpressResponse } from "express";
import { InlineKeyboard, webhookCallback } from "grammy";
import { CreateMailSessionResponse, GetMailInboxResponse, GetMailMessageParams, GetMailMessageResponse, GetMailSessionResponse, RefreshMailSessionResponse, UpdateMailLanguageBody, UpdateMailLanguageResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { upsertTelegramUser } from "../lib/database";
import { writeAuditLog } from "../lib/admin";
import { isAdminId, isPreviewUser, safeLanguage, type TelegramUser } from "../lib/telegram-auth";
import { telegramAppUrl, telegramBot, telegramWebhookSecret } from "../lib/telegram-bot";
import { createInbox, deleteInbox, getMessage, listMessages, pollInterval, ProviderPoolError, type MailMessage, type ProviderInbox } from "../lib/mail-providers";
import { recordMailError, type MailErrorCode } from "../lib/operations-status";

type Language = "tr" | "ru" | "en";
type MailSession = {
  userId: string; language: Language; inbox: ProviderInbox; expiresAt: number; refreshesUsed: number;
  lastInboxCheck: number; messages: MailMessage[]; notifiedMessageIds: Set<string>; createdAt: number;
  databaseId: string | null; inboxFetchPromise?: Promise<MailMessage[]>;
};
const router: IRouter = Router();
const sessions = new Map<string, MailSession>();
const newAddressEvents = new Map<string, number[]>();
const SESSION_MS = 10 * 60 * 1000;
const MAX_REFRESHES = 3;
const bot = telegramBot;
const appUrl = telegramAppUrl();
const adminPanelUrl = appUrl ? `${appUrl}/admin` : "";
const adminCopy = { title: "Yönetim paneli", open: "Paneli aç", missingAppUrl: "Yönetim paneli açılamadı: APP_URL ayarlı değil." };
const copy: Record<Language, { welcome: string; button: string; newMail: string }> = {
  tr: { welcome: "Tek kullanımlık e-posta adresin hazır. Başlamak için aşağıdaki butona dokun.", button: "Geçici Mail Aç", newMail: "Yeni e-posta geldi" },
  ru: { welcome: "Твой одноразовый адрес готов. Нажми кнопку ниже, чтобы начать.", button: "Открыть почту", newMail: "Новое письмо" },
  en: { welcome: "Your disposable email is ready. Tap the button below to get started.", button: "Open Temp Mail", newMail: "New email received" },
};
function getTelegramUser(res: ExpressResponse): TelegramUser | null { return (res.locals.telegramUser as TelegramUser | undefined) ?? null; }
function error(res: ExpressResponse, status: number, message: string) { return res.status(status).json({ error: message }); }
function sessionError(res: ExpressResponse, status: number, code: MailErrorCode, retryAfterSeconds: number) {
  recordMailError(code); res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(status).json({ error: code.toLowerCase(), code, retryAfterSeconds });
}
function publicSession(session: MailSession) { return { address: session.inbox.address, expiresAt: new Date(session.expiresAt), refreshesUsed: session.refreshesUsed, refreshesLimit: MAX_REFRESHES, language: session.language }; }
function hasNewAddressQuota(userId: string) {
  const now = Date.now(); const recent = (newAddressEvents.get(userId) ?? []).filter((at) => now - at < 3_600_000);
  newAddressEvents.set(userId, recent); return recent.length < 10;
}
function recordNewAddress(userId: string) { newAddressEvents.set(userId, [...(newAddressEvents.get(userId) ?? []), Date.now()]); }
async function createSessionForUser(user: TelegramUser, previous?: MailSession) {
  if (!hasNewAddressQuota(user.id)) throw Object.assign(new Error("rate_limited"), { code: "USER_RATE_LIMIT" });
  const inbox = await createInbox();
  const createdAt = Date.now(); const expiresAt = createdAt + SESSION_MS;
  const session: MailSession = { userId: user.id, language: user.language, inbox, expiresAt, refreshesUsed: 0, lastInboxCheck: 0, messages: [], notifiedMessageIds: new Set(), createdAt, databaseId: null };
  if (!isPreviewUser(user.id)) {
    try {
      const result = await pool.query<{ id: string }>(`INSERT INTO mail_sessions (telegram_id, provider, created_at, expires_at, mail_count) VALUES ($1,$2,$3,$4,0) RETURNING id::text`, [user.id, inbox.provider, new Date(createdAt), new Date(expiresAt)]);
      session.databaseId = result.rows[0]?.id ?? null;
      if (!session.databaseId) throw new Error("Statistics row missing");
    } catch (caught) { await deleteInbox(inbox); throw Object.assign(new Error("database failure", { cause: caught }), { code: "DB_ERROR" }); }
  }
  if (previous) {
    sessions.delete(user.id); await deleteInbox(previous.inbox);
    if (previous.databaseId) await pool.query("UPDATE mail_sessions SET expires_at=NOW() WHERE id=$1", [previous.databaseId]).catch(() => undefined);
  }
  sessions.set(user.id, session); recordNewAddress(user.id); return session;
}
async function notifyNewMail(userId: string, language: Language, message: MailMessage) {
  if (!bot || isPreviewUser(userId)) return;
  try {
    const state = await pool.query<{ banned: boolean }>("SELECT banned FROM users WHERE telegram_id=$1", [userId]);
    if (state.rows[0]?.banned) return;
    const keyboard = appUrl ? new InlineKeyboard().webApp(copy[language].button, appUrl) : undefined;
    await bot.api.sendMessage(userId, `${copy[language].newMail}\n${message.sender}\n${message.subject}`, keyboard ? { reply_markup: keyboard } : {});
  } catch (caught) { logger.warn({ userId, err: caught }, "Could not send new mail notification"); }
}
async function fetchInbox(session: MailSession) {
  if (session.inboxFetchPromise) return session.inboxFetchPromise;
  if (Date.now() - session.lastInboxCheck < pollInterval(session.inbox)) return session.messages;
  const operation = (async () => {
    session.lastInboxCheck = Date.now();
    const incoming = (await listMessages(session.inbox)).sort((a,b) => b.receivedAt.getTime()-a.receivedAt.getTime());
    const previous = new Map(session.messages.map((item) => [item.id,item]));
    const fresh = incoming.filter((item) => !previous.has(item.id));
    session.messages = incoming.map((item) => ({ ...item, isRead: previous.get(item.id)?.isRead ?? item.isRead }));
    if (fresh.length && session.databaseId) await pool.query(`UPDATE mail_sessions SET mail_count=mail_count+$2,last_mail_at=GREATEST(COALESCE(last_mail_at,$3),$3) WHERE id=$1`, [session.databaseId, fresh.length, new Date(Math.max(...fresh.map((m)=>m.receivedAt.getTime())))]);
    for (const item of fresh) if (!session.notifiedMessageIds.has(item.id)) { session.notifiedMessageIds.add(item.id); await notifyNewMail(session.userId, session.language, item); }
    return session.messages;
  })();
  session.inboxFetchPromise = operation; try { return await operation; } finally { session.inboxFetchPromise = undefined; }
}
function handleCreationError(res: ExpressResponse, caught: unknown) {
  const code = caught instanceof ProviderPoolError ? caught.code : (caught as { code?: string })?.code;
  if (code === "USER_RATE_LIMIT") return sessionError(res, 429, code, 3600);
  if (caught instanceof ProviderPoolError) return sessionError(res, caught.code === "PROVIDERS_BUSY" ? 503 : 502, caught.code, caught.retryAfterSeconds);
  if (code === "DB_ERROR") return sessionError(res, 500, "DB_ERROR", 60);
  return sessionError(res, 500, "UNKNOWN", 60);
}
router.get("/mail/session", async (_req,res) => {
  const user=getTelegramUser(res); if(!user) return error(res,401,"Unauthorized");
  const current=sessions.get(user.id); if(current?.expiresAt && current.expiresAt>Date.now()) return res.json(GetMailSessionResponse.parse(publicSession(current)));
  try { return res.json(GetMailSessionResponse.parse(publicSession(await createSessionForUser(user,current)))); }
  catch(caught) { logger.error({ userId:user.id, code:(caught as {code?:string})?.code },"Could not create mail session"); return handleCreationError(res,caught); }
});
router.post("/mail/session", async (_req,res) => {
  const user=getTelegramUser(res); if(!user) return error(res,401,"Unauthorized");
  try { return res.status(201).json(CreateMailSessionResponse.parse(publicSession(await createSessionForUser(user,sessions.get(user.id))))); }
  catch(caught) { logger.error({ userId:user.id, code:(caught as {code?:string})?.code },"Could not replace mail session"); return handleCreationError(res,caught); }
});
router.post("/mail/session/refresh", async (_req,res) => {
  const user=getTelegramUser(res); if(!user) return error(res,401,"Unauthorized"); const session=sessions.get(user.id);
  if(!session||session.expiresAt<=Date.now()) return error(res,404,"Session expired"); if(session.refreshesUsed>=MAX_REFRESHES) return error(res,409,"Refresh limit reached");
  session.refreshesUsed++; session.expiresAt=Date.now()+SESSION_MS;
  if(session.databaseId) await pool.query("UPDATE mail_sessions SET expires_at=$2 WHERE id=$1",[session.databaseId,new Date(session.expiresAt)]);
  return res.json(RefreshMailSessionResponse.parse(publicSession(session)));
});
router.post("/mail/session/language",async(req,res)=>{ const user=getTelegramUser(res); if(!user)return error(res,401,"Unauthorized"); const parsed=UpdateMailLanguageBody.safeParse(req.body); if(!parsed.success)return error(res,400,"Invalid language"); const session=sessions.get(user.id); if(!session)return error(res,404,"Session not found"); session.language=parsed.data.language; return res.json(UpdateMailLanguageResponse.parse(publicSession(session))); });
router.get("/mail/inbox",async(_req,res)=>{ const user=getTelegramUser(res); if(!user)return error(res,401,"Unauthorized"); const session=sessions.get(user.id); if(!session||session.expiresAt<=Date.now())return error(res,404,"Session expired"); try { const messages=await fetchInbox(session); return res.json(GetMailInboxResponse.parse({messages,unreadCount:messages.filter(m=>!m.isRead).length,checkedAt:new Date()})); } catch { return error(res,502,"Inbox unavailable"); } });
router.get("/mail/messages/:messageId",async(req,res)=>{ const user=getTelegramUser(res); if(!user)return error(res,401,"Unauthorized"); const params=GetMailMessageParams.safeParse(req.params); if(!params.success)return error(res,400,"Invalid message id"); const session=sessions.get(user.id); if(!session||session.expiresAt<=Date.now())return error(res,404,"Session expired"); try { const found=await getMessage(session.inbox,params.data.messageId); if(!found)return error(res,404,"Message not found"); found.isRead=true; session.messages=session.messages.map(m=>m.id===found.id?found:m); return res.json(GetMailMessageResponse.parse(found)); } catch { return error(res,502,"Message unavailable"); } });
setInterval(()=>{ const now=Date.now(); for(const [id,session] of sessions) if(session.expiresAt<=now){ sessions.delete(id); void deleteInbox(session.inbox); } },30_000).unref();

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
