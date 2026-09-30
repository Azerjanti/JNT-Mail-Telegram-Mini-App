import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { telegramBot } from "../lib/telegram-bot";
import { clearMembershipCache } from "../lib/gate";
import { getAdminUser, safeErrorMessage, writeAuditLog } from "../lib/admin";

const router: IRouter = Router();

function validChatId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^@[A-Za-z0-9_]{5,32}$/.test(value) || /^-100\d{5,16}$/.test(value);
}

function validInviteLink(value: unknown): value is string | null {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string" || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["t.me", "telegram.me"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function botIsChannelAdmin(chatId: string): Promise<{ ok: boolean; message: string | null; chatId?: string; title?: string; username?: string | null }> {
  if (!telegramBot) return { ok: false, message: "BOT_TOKEN ayarlanmamış" };
  try {
    const chat = await telegramBot.api.getChat(chatId);
    if (chat.type !== "channel" && chat.type !== "supergroup") {
      return { ok: false, message: "Belirtilen sohbet bir kanal veya süper grup değil" };
    }
    const botInfo = await telegramBot.api.getMe();
    const member = await telegramBot.api.getChatMember(chat.id, botInfo.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    return {
      ok: isAdmin,
      message: isAdmin ? null : "Bot bu kanalda yönetici değil. Botu kanal yöneticisi yapıp tekrar deneyin.",
      chatId: String(chat.id),
      title: "title" in chat ? chat.title : "Telegram kanalı",
      username: "username" in chat ? chat.username ?? null : null,
    };
  } catch (caught) {
    return { ok: false, message: `Telegram kanalı doğrulanamadı: ${safeErrorMessage(caught)}` };
  }
}

router.get("/channels", async (_req, res) => {
  const admin = getAdminUser(res);
  try {
    const [channels, setting] = await Promise.all([
      pool.query<{
        id: string;
        chat_id: string;
        username: string | null;
        title: string;
        invite_link: string | null;
        enabled: boolean;
        created_at: Date;
        last_check_error: string | null;
      }>("SELECT id::text, chat_id, username, title, invite_link, enabled, created_at, last_check_error FROM channels ORDER BY created_at DESC"),
      pool.query<{ value: string }>("SELECT value FROM settings WHERE key = 'subscription_required'"),
    ]);

    const checked = await Promise.all(channels.rows.map(async (channel) => {
      const result = await botIsChannelAdmin(channel.chat_id);
      const error = result.message;
      await pool.query("UPDATE channels SET last_check_error = $2 WHERE id = $1", [channel.id, error]);
      return {
        id: channel.id,
        chatId: channel.chat_id,
        username: channel.username,
        title: channel.title,
        inviteLink: channel.invite_link,
        enabled: channel.enabled,
        createdAt: channel.created_at,
        botAdmin: result.ok,
        error,
      };
    }));

    await writeAuditLog(admin.id, "admin.channels.view", {});
    res.json({
      channels: checked,
      subscriptionRequired: setting.rows[0]?.value === "true",
    });
  } catch {
    res.status(500).json({ error: "channels_failed" });
  }
});

router.post("/channels", async (req, res) => {
  const admin = getAdminUser(res);
  const chatId = typeof req.body?.chatId === "string" ? req.body.chatId.trim() : "";
  const inviteLink = req.body?.inviteLink === "" ? null : req.body?.inviteLink ?? null;
  if (!validChatId(chatId)) {
    res.status(400).json({ error: "chat_id_invalid", message: "Kanal @kullanıcıadı veya -100 ile başlayan sohbet kimliği olmalı" });
    return;
  }
  if (!validInviteLink(inviteLink)) {
    res.status(400).json({ error: "invite_link_invalid", message: "Davet bağlantısı t.me adresi olmalı" });
    return;
  }

  const check = await botIsChannelAdmin(chatId);
  if (!check.ok) {
    res.status(400).json({ error: "bot_not_admin", message: check.message ?? "Bot kanalda yönetici değil" });
    return;
  }

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO channels (chat_id, username, title, invite_link, enabled, created_at, last_check_error)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), NULL)
       ON CONFLICT (chat_id) DO UPDATE SET
         username = EXCLUDED.username,
         title = EXCLUDED.title,
         invite_link = EXCLUDED.invite_link,
         last_check_error = NULL
       RETURNING id::text`,
      [check.chatId ?? chatId, check.username ?? (chatId.startsWith("@") ? chatId.slice(1) : null), check.title ?? chatId, inviteLink],
    );
    clearMembershipCache();
    await writeAuditLog(admin.id, "admin.channels.create", { channelId: result.rows[0]?.id, chatId });
    res.status(201).json({ ok: true, id: result.rows[0]?.id });
  } catch {
    res.status(500).json({ error: "channel_create_failed" });
  }
});

router.patch("/channels/:id", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id) || typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "channel_update_invalid" });
    return;
  }
  try {
    const result = await pool.query("UPDATE channels SET enabled = $2 WHERE id = $1", [id, req.body.enabled]);
    if (!result.rowCount) {
      res.status(404).json({ error: "channel_not_found" });
      return;
    }
    clearMembershipCache();
    await writeAuditLog(admin.id, "admin.channels.toggle", { channelId: id, enabled: req.body.enabled });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "channel_update_failed" });
  }
});

router.delete("/channels/:id", async (req, res) => {
  const admin = getAdminUser(res);
  const id = String(req.params.id);
  if (!/^\d{1,18}$/.test(id)) {
    res.status(400).json({ error: "channel_id_invalid" });
    return;
  }
  try {
    const result = await pool.query("DELETE FROM channels WHERE id = $1", [id]);
    if (!result.rowCount) {
      res.status(404).json({ error: "channel_not_found" });
      return;
    }
    clearMembershipCache();
    await writeAuditLog(admin.id, "admin.channels.delete", { channelId: id });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "channel_delete_failed" });
  }
});

router.put("/subscription", async (req, res) => {
  const admin = getAdminUser(res);
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "subscription_setting_invalid" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('subscription_required', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(req.body.enabled)],
    );
    clearMembershipCache();
    await writeAuditLog(admin.id, "admin.subscription.toggle", { enabled: req.body.enabled });
    res.json({ enabled: req.body.enabled });
  } catch {
    res.status(500).json({ error: "subscription_setting_failed" });
  }
});

export default router;
