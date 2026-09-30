import { Router, type IRouter, type RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { InputFile, InlineKeyboard } from "grammy";
import { pool } from "@workspace/db";
import { getAdminUser, safeErrorMessage, writeAuditLog } from "../lib/admin";
import { logger } from "../lib/logger";
import { telegramBot } from "../lib/telegram-bot";

const router: IRouter = Router();
const MAX_MEDIA_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_SIZE = 100 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_MEDIA_FILES, fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "video/mp4"].includes(file.mimetype);
    if (!allowed) {
      callback(new Error("Yalnızca JPEG, PNG ve MP4 dosyaları yüklenebilir"));
      return;
    }
    callback(null, true);
  },
});

type AnnouncementMedia = { type: "photo" | "video"; file_id: string };
type AnnouncementRow = {
  id: string;
  text: string;
  parse_html: boolean;
  media: AnnouncementMedia[];
  button_text: string | null;
  button_url: string | null;
  target_lang: "all" | "tr" | "ru" | "en";
  status: string;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  last_user_id: string;
  target_max_user_id: string;
};

type TelegramErrorShape = {
  error_code?: number;
  parameters?: { retry_after?: number };
  description?: string;
};

const uploadMiddleware: RequestHandler = (req, res, next) => {
  upload.array("media", MAX_MEDIA_FILES)(req, res, (caught) => {
    if (!caught) {
      next();
      return;
    }
    const message = caught instanceof Error ? caught.message : "Dosya yüklenemedi";
    const status = caught instanceof MulterError && caught.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({ error: "upload_invalid", message });
  });
};

function getFiles(req: Parameters<RequestHandler>[0]): Express.Multer.File[] {
  return (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
}

function fieldString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "tg:"].includes(url.protocol.toLowerCase());
  } catch {
    return false;
  }
}

function getButtonKeyboard(buttonText: string | null, buttonUrl: string | null) {
  if (!buttonText || !buttonUrl) return undefined;
  return new InlineKeyboard().url(buttonText, buttonUrl);
}

function parseMode(parseHtml: boolean): "HTML" | undefined {
  return parseHtml ? "HTML" : undefined;
}

function fileType(file: Express.Multer.File): "photo" | "video" {
  return file.mimetype === "video/mp4" ? "video" : "photo";
}

function hasValidFileSignature(file: Express.Multer.File): boolean {
  if (file.mimetype === "image/jpeg") {
    return file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  }
  if (file.mimetype === "image/png") {
    return file.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return file.mimetype === "video/mp4" && file.buffer.toString("ascii", 4, 8) === "ftyp";
}

function largestPhotoId(message: unknown): string | null {
  const result = message as { photo?: Array<{ file_id?: string }>; video?: { file_id?: string } };
  if (result.video?.file_id) return result.video.file_id;
  const photo = result.photo?.at(-1)?.file_id;
  return photo ?? null;
}

function getTelegramErrorCode(caught: unknown): number | null {
  if (typeof caught !== "object" || caught === null) return null;
  const errorCode = (caught as TelegramErrorShape).error_code;
  return typeof errorCode === "number" ? errorCode : null;
}

function getRetryAfter(caught: unknown): number | null {
  if (typeof caught !== "object" || caught === null) return null;
  const retryAfter = (caught as TelegramErrorShape).parameters?.retry_after;
  return typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let telegramQueue: Promise<void> = Promise.resolve();
let nextTelegramMessageAt = 0;

function queueTelegramCall<T>(operation: () => Promise<T>, messageCount = 1): Promise<T> {
  const task = telegramQueue.then(async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const wait = Math.max(0, nextTelegramMessageAt - Date.now());
      if (wait > 0) await delay(wait);
      const startedAt = Date.now();
      nextTelegramMessageAt = startedAt + Math.max(1, messageCount) * 40;
      try {
        return await operation();
      } catch (caught) {
        const retryAfter = getRetryAfter(caught);
        if (getTelegramErrorCode(caught) !== 429 || retryAfter === null || attempt === 7) throw caught;
        await delay(retryAfter * 1000 + 100);
        nextTelegramMessageAt = Date.now();
      }
    }
    throw new Error("Telegram API retry limit reached");
  });
  telegramQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function sendUploadedTest(
  chatId: number,
  text: string,
  parseHtml: boolean,
  buttonText: string | null,
  buttonUrl: string | null,
  files: Express.Multer.File[],
): Promise<AnnouncementMedia[]> {
  const bot = telegramBot;
  if (!bot) throw new Error("BOT_TOKEN ayarlanmamış");
  const keyboard = getButtonKeyboard(buttonText, buttonUrl);
  const mode = parseMode(parseHtml);
  const mediaIds: AnnouncementMedia[] = [];

  if (files.length === 0) {
    await queueTelegramCall(() => bot.api.sendMessage(chatId, text, {
      ...(mode ? { parse_mode: mode } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }));
    return mediaIds;
  }

  if (files.length === 1) {
    const file = files[0]!;
    const type = fileType(file);
    const input = new InputFile(file.buffer, `jnt-announcement-${Date.now()}-${type === "video" ? "video.mp4" : "photo"}`);
    const caption = text.length <= 1024 ? text : "";
    const options = {
      ...(caption ? { caption, ...(mode ? { parse_mode: mode } : {}) } : {}),
      ...(text.length <= 1024 && keyboard ? { reply_markup: keyboard } : {}),
    };
    const sent = type === "video"
      ? await queueTelegramCall(() => bot.api.sendVideo(chatId, input, options))
      : await queueTelegramCall(() => bot.api.sendPhoto(chatId, input, options));
    const fileId = largestPhotoId(sent);
    if (!fileId) throw new Error("Telegram bir dosya kimliği döndürmedi");
    mediaIds.push({ type, file_id: fileId });
    if (text.length > 1024) {
      await queueTelegramCall(() => bot.api.sendMessage(chatId, text, {
        ...(mode ? { parse_mode: mode } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }));
    }
    return mediaIds;
  }

  const album = files.map((file, index) => {
    const type = fileType(file);
    const caption = index === 0 && text.length <= 1024 ? text : "";
    return {
      type,
      media: new InputFile(file.buffer, `jnt-announcement-${Date.now()}-${index}.${type === "video" ? "mp4" : "jpg"}`),
      ...(caption ? { caption, ...(mode ? { parse_mode: mode } : {}) } : {}),
    };
  });
  const sent = await queueTelegramCall(() => bot.api.sendMediaGroup(chatId, album as never), album.length);
  for (let index = 0; index < files.length; index += 1) {
    const fileId = largestPhotoId(sent[index]);
    if (!fileId) throw new Error("Telegram bir dosya kimliği döndürmedi");
    mediaIds.push({ type: fileType(files[index]!), file_id: fileId });
  }

  if (text.length > 1024) {
    await queueTelegramCall(() => bot.api.sendMessage(chatId, text, {
      ...(mode ? { parse_mode: mode } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }));
  } else if (keyboard && buttonText) {
    await queueTelegramCall(() => bot.api.sendMessage(chatId, buttonText, { reply_markup: keyboard }));
  }
  return mediaIds;
}

function normalizeAnnouncement(row: AnnouncementRow) {
  return {
    id: row.id,
    text: row.text,
    parseHtml: row.parse_html,
    media: row.media,
    buttonText: row.button_text,
    buttonUrl: row.button_url,
    targetLang: row.target_lang,
    status: row.status,
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    blocked: row.blocked,
  };
}

async function loadAnnouncement(id: string): Promise<AnnouncementRow | null> {
  const result = await pool.query<AnnouncementRow>(
    `SELECT id::text, text, parse_html, media, button_text, button_url, target_lang,
      status, total, sent, failed, blocked, last_user_id::text, target_max_user_id::text
     FROM announcements WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

function validAnnouncementInput(body: Record<string, unknown>, hasMedia: boolean): {
  text: string;
  parseHtml: boolean;
  buttonText: string | null;
  buttonUrl: string | null;
  targetLang: "all" | "tr" | "ru" | "en";
} | null {
  const text = typeof body.text === "string" ? body.text : "";
  const parseHtml = body.parseHtml === true || body.parseHtml === "true";
  const rawButtonText = fieldString(body.buttonText);
  const buttonText = rawButtonText || null;
  const rawButtonUrl = fieldString(body.buttonUrl);
  const buttonUrl = rawButtonUrl || null;
  const rawTarget = fieldString(body.targetLang) || "all";
  if (text.length > 4096 || (!text.trim() && !hasMedia)) return null;
  if (buttonText && buttonText.length > 64) return null;
  if (Boolean(buttonText) !== Boolean(buttonUrl)) return null;
  if (buttonUrl && (buttonUrl.length > 2048 || !isAllowedUrl(buttonUrl))) return null;
  if (!["all", "tr", "ru", "en"].includes(rawTarget)) return null;
  return {
    text,
    parseHtml,
    buttonText,
    buttonUrl,
    targetLang: rawTarget as "all" | "tr" | "ru" | "en",
  };
}

router.get("/announcements", async (_req, res) => {
  const admin = getAdminUser(res);
  try {
    const result = await pool.query<{
      id: string;
      text: string;
      target_lang: string;
      status: string;
      total: number;
      sent: number;
      failed: number;
      blocked: number;
      created_at: Date;
      finished_at: Date | null;
    }>(`
      SELECT id::text, text, target_lang, status, total, sent, failed, blocked, created_at, finished_at
      FROM announcements ORDER BY created_at DESC LIMIT 30
    `);
    await writeAuditLog(admin.id, "admin.announcements.view", {});
    res.json({ announcements: result.rows.map((row) => ({
      id: row.id,
      text: row.text.slice(0, 140),
      targetLang: row.target_lang,
      status: row.status,
      total: row.total,
      sent: row.sent,
      failed: row.failed,
      blocked: row.blocked,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    })) });
  } catch {
    res.status(500).json({ error: "announcements_failed" });
  }
});

router.get("/announcements/:id", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "announcement_id_invalid" });
    return;
  }
  try {
    const announcement = await loadAnnouncement(id);
    if (!announcement) {
      res.status(404).json({ error: "announcement_not_found" });
      return;
    }
    await writeAuditLog(admin.id, "admin.announcement.view", { announcementId: id });
    res.json(normalizeAnnouncement(announcement));
  } catch {
    res.status(500).json({ error: "announcement_failed" });
  }
});

router.put("/announcements/:id", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "announcement_id_invalid" });
    return;
  }
  try {
    const existing = await loadAnnouncement(id);
    if (!existing) {
      res.status(404).json({ error: "announcement_not_found" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "announcement_not_editable" });
      return;
    }
    const input = validAnnouncementInput(req.body as Record<string, unknown>, existing.media.length > 0);
    if (!input) {
      res.status(400).json({ error: "announcement_input_invalid" });
      return;
    }
    await pool.query(
      `UPDATE announcements SET text = $2, parse_html = $3, button_text = $4,
        button_url = $5, target_lang = $6 WHERE id = $1`,
      [id, input.text, input.parseHtml, input.buttonText, input.buttonUrl, input.targetLang],
    );
    const updated = await loadAnnouncement(id);
    if (!updated) throw new Error("Duyuru kaydı bulunamadı");
    await writeAuditLog(admin.id, "admin.announcement.update", { announcementId: id });
    res.json(normalizeAnnouncement(updated));
  } catch {
    res.status(500).json({ error: "announcement_update_failed" });
  }
});

router.get("/announcements/:id/audience", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "announcement_id_invalid" });
    return;
  }
  try {
    const announcement = await loadAnnouncement(id);
    if (!announcement) {
      res.status(404).json({ error: "announcement_not_found" });
      return;
    }
    const result = await pool.query<{ recipients: string }>(
      "SELECT COUNT(*)::text AS recipients FROM users WHERE banned = FALSE AND bot_blocked = FALSE AND ($1 = 'all' OR language = $1)",
      [announcement.target_lang],
    );
    const recipients = Number(result.rows[0]?.recipients ?? 0);
    await writeAuditLog(admin.id, "admin.announcement.audience", { announcementId: id, recipientCount: recipients });
    res.json({ recipients });
  } catch {
    res.status(500).json({ error: "announcement_audience_failed" });
  }
});

router.post("/announcements/test", uploadMiddleware, async (req, res) => {
  const admin = getAdminUser(res);
  const files = getFiles(req);
  if (files.some((file) => !hasValidFileSignature(file))) {
    res.status(400).json({ error: "upload_type_invalid", message: "Dosya içeriği bildirilen türle eşleşmiyor" });
    return;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_SIZE) {
    res.status(413).json({ error: "upload_total_too_large", message: "Toplam dosya boyutu 100 MB sınırını aşamaz" });
    return;
  }
  const input = validAnnouncementInput(req.body as Record<string, unknown>, files.length > 0);
  if (!input) {
    res.status(400).json({ error: "announcement_input_invalid", message: "Metin, dil veya buton bilgilerini kontrol edin" });
    return;
  }
  if (!telegramBot) {
    res.status(503).json({ error: "bot_unavailable", message: "BOT_TOKEN ayarlanmamış" });
    return;
  }

  try {
    const media = await sendUploadedTest(
      Number(admin.id), input.text, input.parseHtml, input.buttonText, input.buttonUrl, files,
    );
    const result = await pool.query<AnnouncementRow>(
      `INSERT INTO announcements
        (text, parse_html, media, button_text, button_url, target_lang, status, total, sent, failed, blocked, created_at, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'draft', 0, 0, 0, 0, NOW(), $7)
       RETURNING id::text, text, parse_html, media, button_text, button_url, target_lang,
        status, total, sent, failed, blocked, last_user_id::text, target_max_user_id::text`,
      [input.text, input.parseHtml, JSON.stringify(media), input.buttonText, input.buttonUrl, input.targetLang, admin.id],
    );
    const announcement = result.rows[0];
    if (!announcement) throw new Error("Duyuru kaydı oluşturulamadı");
    await writeAuditLog(admin.id, "admin.announcement.test", { announcementId: announcement.id, mediaCount: media.length });
    res.status(201).json(normalizeAnnouncement(announcement));
  } catch (caught) {
    logger.warn({ adminId: admin.id, err: safeErrorMessage(caught) }, "Announcement test send failed");
    res.status(502).json({ error: "announcement_test_failed", message: safeErrorMessage(caught) });
  }
});

router.post("/announcements/:id/send", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id) || req.body?.confirm !== true) {
    res.status(400).json({ error: "send_confirmation_required" });
    return;
  }
  if (!telegramBot) {
    res.status(503).json({ error: "bot_unavailable" });
    return;
  }

  try {
    const announcement = await loadAnnouncement(id);
    if (!announcement) {
      res.status(404).json({ error: "announcement_not_found" });
      return;
    }
    if (announcement.status === "sending") {
      res.status(409).json({ error: "announcement_already_sending" });
      return;
    }
    if (announcement.status === "finished") {
      res.status(409).json({ error: "announcement_already_finished" });
      return;
    }

    const [countResult, maxResult] = await Promise.all([
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM users WHERE banned = FALSE AND bot_blocked = FALSE AND ($1 = 'all' OR language = $1)",
        [announcement.target_lang],
      ),
      pool.query<{ max_id: string | null }>(
        "SELECT MAX(telegram_id)::text AS max_id FROM users WHERE banned = FALSE AND bot_blocked = FALSE AND ($1 = 'all' OR language = $1)",
        [announcement.target_lang],
      ),
    ]);
    const total = Number(countResult.rows[0]?.count ?? 0);
    const maxUserId = maxResult.rows[0]?.max_id ?? "0";
    await pool.query(
      `UPDATE announcements SET status = 'sending', total = $2, sent = 0, failed = 0, blocked = 0,
         last_user_id = 0, target_max_user_id = $3, finished_at = NULL WHERE id = $1`,
      [id, total, maxUserId],
    );
    await writeAuditLog(admin.id, "admin.announcement.send", { announcementId: id, recipientCount: total });
    void runAnnouncement(id);
    res.status(202).json({ ok: true, id, total, status: "sending" });
  } catch {
    res.status(500).json({ error: "announcement_start_failed" });
  }
});

router.get("/announcements/:id/progress", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "announcement_id_invalid" });
    return;
  }
  try {
    const result = await pool.query<{
      id: string;
      status: string;
      total: number;
      sent: number;
      failed: number;
      blocked: number;
      created_at: Date;
      finished_at: Date | null;
    }>(`
      SELECT id::text, status, total, sent, failed, blocked, created_at, finished_at
      FROM announcements WHERE id = $1
    `, [id]);
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: "announcement_not_found" });
      return;
    }
    await writeAuditLog(admin.id, "admin.announcement.progress", { announcementId: id });
    res.json({
      id: row.id,
      status: row.status,
      total: row.total,
      sent: row.sent,
      failed: row.failed,
      blocked: row.blocked,
      finishedAt: row.finished_at,
      percent: row.total === 0 ? (row.status === "finished" ? 100 : 0) : Math.min(100, Math.floor(((row.sent + row.failed + row.blocked) / row.total) * 100)),
    });
  } catch {
    res.status(500).json({ error: "announcement_progress_failed" });
  }
});

async function sendStoredAnnouncement(chatId: number, announcement: AnnouncementRow): Promise<void> {
  const bot = telegramBot;
  if (!bot) throw new Error("BOT_TOKEN ayarlanmamış");
  const media = Array.isArray(announcement.media) ? announcement.media : [];
  const text = announcement.text ?? "";
  const buttonText = announcement.button_text;
  const buttonUrl = announcement.button_url;
  const keyboard = getButtonKeyboard(buttonText, buttonUrl);
  const mode = parseMode(announcement.parse_html);

  if (media.length === 0) {
    await queueTelegramCall(() => bot.api.sendMessage(chatId, text, {
      ...(mode ? { parse_mode: mode } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }));
    return;
  }

  if (media.length === 1) {
    const item = media[0]!;
    const caption = text.length <= 1024 ? text : "";
    const options = {
      ...(caption ? { caption, ...(mode ? { parse_mode: mode } : {}) } : {}),
      ...(text.length <= 1024 && keyboard ? { reply_markup: keyboard } : {}),
    };
    if (item.type === "video") {
      await queueTelegramCall(() => bot.api.sendVideo(chatId, item.file_id, options));
    } else {
      await queueTelegramCall(() => bot.api.sendPhoto(chatId, item.file_id, options));
    }
    if (text.length > 1024) {
      await queueTelegramCall(() => bot.api.sendMessage(chatId, text, {
        ...(mode ? { parse_mode: mode } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }));
    }
    return;
  }

  const album = media.map((item, index) => ({
    type: item.type,
    media: item.file_id,
    ...(index === 0 && text.length <= 1024 && text ? { caption: text, ...(mode ? { parse_mode: mode } : {}) } : {}),
  }));
  await queueTelegramCall(() => bot.api.sendMediaGroup(chatId, album as never), album.length);
  if (text.length > 1024) {
    await queueTelegramCall(() => bot.api.sendMessage(chatId, text, {
      ...(mode ? { parse_mode: mode } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }));
  } else if (keyboard && buttonText) {
    await queueTelegramCall(() => bot.api.sendMessage(chatId, buttonText, { reply_markup: keyboard }));
  }
}

async function runAnnouncement(id: string): Promise<void> {
  if (activeAnnouncements.has(id)) return;
  activeAnnouncements.add(id);
  try {
    for (;;) {
      const announcement = await loadAnnouncement(id);
      if (!announcement || announcement.status !== "sending") return;
      const result = await pool.query<{ telegram_id: string }>(
        `SELECT u.telegram_id::text
         FROM users u
         WHERE u.telegram_id > $1 AND u.telegram_id <= $2
           AND u.banned = FALSE AND u.bot_blocked = FALSE
           AND ($3 = 'all' OR u.language = $3)
           AND NOT EXISTS (
             SELECT 1 FROM announcement_deliveries d
             WHERE d.announcement_id = $4 AND d.telegram_id = u.telegram_id
           )
         ORDER BY u.telegram_id LIMIT 1`,
        [announcement.last_user_id, announcement.target_max_user_id, announcement.target_lang, id],
      );
      const telegramId = result.rows[0]?.telegram_id;
      if (!telegramId) {
        await pool.query("UPDATE announcements SET total = sent + failed + blocked, status = 'finished', finished_at = NOW() WHERE id = $1 AND status = 'sending'", [id]);
        return;
      }

      let outcome: "sent" | "failed" | "blocked" | "skipped" = "sent";
      const recipientState = await pool.query<{ banned: boolean; bot_blocked: boolean; language: string }>(
        "SELECT banned, bot_blocked, language FROM users WHERE telegram_id = $1",
        [telegramId],
      );
      const recipient = recipientState.rows[0];
      if (!recipient || recipient.banned || recipient.bot_blocked || (announcement.target_lang !== "all" && recipient.language !== announcement.target_lang)) {
        outcome = "skipped";
      } else {
        try {
          await sendStoredAnnouncement(Number(telegramId), announcement);
        } catch (caught) {
          if (getTelegramErrorCode(caught) === 403) {
            outcome = "blocked";
          } else {
            outcome = "failed";
            logger.warn({ announcementId: id, telegramId, errorCode: getTelegramErrorCode(caught) }, "Announcement delivery failed");
          }
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (outcome === "blocked") {
          await client.query("UPDATE users SET bot_blocked = TRUE WHERE telegram_id = $1", [telegramId]);
        }
        const inserted = await client.query(
          `INSERT INTO announcement_deliveries (announcement_id, telegram_id, result, processed_at)
           VALUES ($1, $2, $3, NOW()) ON CONFLICT (announcement_id, telegram_id) DO NOTHING
           RETURNING telegram_id`,
          [id, telegramId, outcome],
        );
        if (inserted.rowCount) {
          await client.query(
            `UPDATE announcements SET
              sent = sent + CASE WHEN $2 = 'sent' THEN 1 ELSE 0 END,
              failed = failed + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END,
              blocked = blocked + CASE WHEN $2 = 'blocked' THEN 1 ELSE 0 END,
              last_user_id = $3
             WHERE id = $1`,
            [id, outcome, telegramId],
          );
        }
        await client.query("COMMIT");
      } catch (caught) {
        await client.query("ROLLBACK");
        throw caught;
      } finally {
        client.release();
      }
    }
  } catch (caught) {
    logger.error({ announcementId: id, err: safeErrorMessage(caught) }, "Announcement worker stopped; it will resume on restart");
  } finally {
    activeAnnouncements.delete(id);
  }
}

const activeAnnouncements = new Set<string>();

export async function resumePendingAnnouncements(): Promise<void> {
  if (!telegramBot) {
    logger.warn("Pending announcements remain paused until BOT_TOKEN is configured");
    return;
  }
  const result = await pool.query<{ id: string }>("SELECT id::text FROM announcements WHERE status = 'sending' ORDER BY created_at");
  for (const row of result.rows) void runAnnouncement(row.id);
}

export default router;
