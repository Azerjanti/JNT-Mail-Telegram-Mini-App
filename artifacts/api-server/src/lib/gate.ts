import { pool } from "@workspace/db";
import { isAdminId } from "./telegram-auth";
import { telegramBot } from "./telegram-bot";

export type GateChannel = {
  id: string;
  chatId: string;
  username: string | null;
  title: string;
  inviteLink: string | null;
  enabled: boolean;
  joined: boolean;
  error: boolean;
};

export type GateStatus = {
  banned: boolean;
  subscriptionRequired: boolean;
  subscribed: boolean;
  channels: GateChannel[];
};

type MembershipResult = { joined: boolean; error: boolean };
type MembershipCache = {
  expiresAt: number;
  channelKey: string;
  results: Record<string, MembershipResult>;
};

const membershipCache = new Map<string, MembershipCache>();
const CACHE_MS = 60_000;

export function clearMembershipCache(userId?: string): void {
  if (userId) membershipCache.delete(userId);
  else membershipCache.clear();
}

function telegramMemberIsJoined(member: { status?: string; is_member?: boolean }): boolean {
  return member.status === "member" ||
    member.status === "administrator" ||
    member.status === "creator" ||
    (member.status === "restricted" && member.is_member === true);
}

async function updateChannelCheckError(channelId: string, message: string | null): Promise<void> {
  await pool.query("UPDATE channels SET last_check_error = $2 WHERE id = $1", [channelId, message]);
}

export async function getGateStatus(userId: string, forceRefresh = false): Promise<GateStatus> {
  const [userResult, settingResult, channelResult] = await Promise.all([
    pool.query<{ banned: boolean }>("SELECT banned FROM users WHERE telegram_id = $1", [userId]),
    pool.query<{ value: string }>("SELECT value FROM settings WHERE key = 'subscription_required'"),
    pool.query<{
      id: string;
      chat_id: string;
      username: string | null;
      title: string;
      invite_link: string | null;
      enabled: boolean;
    }>(
      "SELECT id::text, chat_id, username, title, invite_link, enabled FROM channels WHERE enabled = TRUE ORDER BY id",
    ),
  ]);

  const channels = channelResult.rows;
  const subscriptionRequired = settingResult.rows[0]?.value === "true";
  const banned = userResult.rows[0]?.banned === true;
  const isAdmin = isAdminId(userId);
  if (!subscriptionRequired || isAdmin || channels.length === 0) {
    return {
      banned,
      subscriptionRequired,
      subscribed: true,
      channels: channels.map((channel) => ({
        id: channel.id,
        chatId: channel.chat_id,
        username: channel.username,
        title: channel.title,
        inviteLink: channel.invite_link,
        enabled: channel.enabled,
        joined: true,
        error: false,
      })),
    };
  }

  const channelKey = channels.map((channel) => `${channel.id}:${channel.chat_id}`).join("|");
  const cached = !forceRefresh ? membershipCache.get(userId) : undefined;
  let results: Record<string, MembershipResult>;
  if (cached && cached.expiresAt > Date.now() && cached.channelKey === channelKey) {
    results = cached.results;
  } else {
    results = {};
    for (const channel of channels) {
      try {
        if (!telegramBot) throw new Error("Telegram bot token is not configured");
        const member = await telegramBot.api.getChatMember(channel.chat_id, Number(userId));
        const joined = telegramMemberIsJoined(member);
        results[channel.id] = { joined, error: false };
        await updateChannelCheckError(channel.id, null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message.slice(0, 500) : "Telegram membership check failed";
        results[channel.id] = { joined: true, error: true };
        await updateChannelCheckError(channel.id, message).catch(() => undefined);
      }
    }
    membershipCache.set(userId, { expiresAt: Date.now() + CACHE_MS, channelKey, results });
  }

  const gateChannels = channels.map((channel) => {
    const membership = results[channel.id] ?? { joined: true, error: true };
    return {
      id: channel.id,
      chatId: channel.chat_id,
      username: channel.username,
      title: channel.title,
      inviteLink: channel.invite_link,
      enabled: channel.enabled,
      joined: membership.joined,
      error: membership.error,
    };
  });
  return {
    banned,
    subscriptionRequired,
    subscribed: gateChannels.every((channel) => channel.joined || channel.error),
    channels: gateChannels,
  };
}
