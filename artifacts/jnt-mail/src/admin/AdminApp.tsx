import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  Ban,
  BellRing,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  ImagePlus,
  LayoutDashboard,
  Loader2,
  Megaphone,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type AdminTab = 'summary' | 'announcements' | 'channels' | 'bans' | 'ads';
type ApiErrorPayload = { error?: string; message?: string };

class AdminApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

type SummaryUser = {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  language: string;
  lastSeen?: string;
  expiresAt?: string;
  remainingSeconds?: number;
  mailCount?: number;
  lastMailAt?: string;
};

type SummaryResponse = {
  totals: {
    totalUsers: number;
    totalSessions: number;
    activeSessions: number;
    newUsersToday: number;
    bannedUsers: number;
  };
  recentUsers: SummaryUser[];
  activeUsers: SummaryUser[];
  mailUsers: SummaryUser[];
};

type ChannelRecord = {
  id: string;
  chatId: string;
  username: string | null;
  title: string;
  inviteLink: string | null;
  enabled: boolean;
  createdAt: string;
  botAdmin: boolean;
  error: string | null;
};

type ChannelResponse = { channels: ChannelRecord[]; subscriptionRequired: boolean };

type AnnouncementMedia = { type: 'photo' | 'video'; file_id: string };
type Announcement = {
  id: string;
  text: string;
  parseHtml: boolean;
  media: AnnouncementMedia[];
  buttonText: string | null;
  buttonUrl: string | null;
  targetLang: 'all' | 'tr' | 'ru' | 'en';
  status: string;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  createdAt?: string;
  finishedAt?: string | null;
};
type AnnouncementListItem = {
  id: string;
  text: string;
  targetLang: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  createdAt: string;
  finishedAt: string | null;
};
type AnnouncementListResponse = { announcements: AnnouncementListItem[] };
type AnnouncementProgress = {
  id: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  finishedAt: string | null;
  percent: number;
};
type BannedUser = {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  language: string;
  reason: string | null;
  bannedAt: string | null;
};
type BanResponse = { users: BannedUser[] };
type AdRecord = {
  id: string;
  title: string;
  text: string;
  linkUrl: string;
  buttonText: string;
  hasImage: boolean;
  hasLogo: boolean;
  active: boolean;
  views: number;
  clicks: number;
  createdAt: string;
};
type AdResponse = { ads: AdRecord[] };

const tabs: Array<{ id: AdminTab; title: string; Icon: LucideIcon }> = [
  { id: 'summary', title: 'Özet', Icon: LayoutDashboard },
  { id: 'announcements', title: 'Duyuru', Icon: Megaphone },
  { id: 'channels', title: 'Kanallar', Icon: Radio },
  { id: 'bans', title: 'Ban', Icon: Ban },
  { id: 'ads', title: 'Reklam', Icon: ImagePlus },
];

function getAdminAuthorization(): string {
  const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp;
  return `tma ${telegram?.initData ?? ''}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.status === 404 || error.code === 'not_found') return 'Yönetici yetkisi doğrulanamadı. Paneli yetkili Telegram hesabınızla açın.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'İşlem tamamlanamadı.';
}

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = new Headers(options.headers);
  headers.set('Authorization', getAdminAuthorization());
  if (!isFormData && options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  const payload = await response.json().catch(() => ({})) as ApiErrorPayload;
  if (!response.ok) {
    throw new AdminApiError(
      payload.message || payload.error || `İstek başarısız (${response.status})`,
      response.status,
      payload.error || 'request_failed',
    );
  }
  return payload as T;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

function useAdminResource<T>(path: string, initialValue: T) {
  const [data, setData] = useState(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void adminFetch<T>(path).then((value) => {
      if (active) setData(value);
    }).catch((caught: unknown) => {
      if (active) setError(errorMessage(caught));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [path, revision]);
  return { data, setData, loading, error, reload: () => setRevision((value) => value + 1) };
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatDuration(seconds = 0): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('tr-TR').format(value || 0);
}

function telegramProfile(user: Pick<SummaryUser, 'telegramId' | 'username'>): string {
  return user.username ? `https://t.me/${user.username.replace(/^@/, '')}` : `tg://user?id=${user.telegramId}`;
}

function openTelegramProfile(user: Pick<SummaryUser, 'telegramId' | 'username'>, event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const link = telegramProfile(user);
  const telegram = (window as Window & { Telegram?: { WebApp?: { openTelegramLink?: (url: string) => void; openLink?: (url: string) => void } } }).Telegram?.WebApp;
  if (link.startsWith('https://t.me/') && telegram?.openTelegramLink) telegram.openTelegramLink(link);
  else if (telegram?.openLink) telegram.openLink(link);
  else window.open(link, '_blank', 'noopener,noreferrer');
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-[#222833] bg-[#12151C] p-4 shadow-[0_10px_32px_rgba(0,0,0,.16)] sm:p-5 ${className}`}>{children}</section>;
}

function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="mb-4">
      <h2 className="font-mono text-sm font-semibold tracking-wide text-[#F1F4F8]">{title}</h2>
      {detail ? <p className="mt-1 text-xs leading-5 text-[#8993A3]">{detail}</p> : null}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  type?: 'button' | 'submit';
  className?: string;
}) {
  const styles = {
    primary: 'bg-[#3B7BFF] text-white hover:bg-[#528BFF]',
    secondary: 'border border-[#303847] bg-[#1A1F29] text-[#D5DCE7] hover:bg-[#222936]',
    danger: 'border border-red-400/20 bg-red-500/10 text-red-300 hover:bg-red-500/15',
    ghost: 'text-[#9AA5B5] hover:bg-[#1A1F29] hover:text-white',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`}>
      {children}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  maxLength,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  maxLength?: number;
  inputMode?: 'text' | 'numeric' | 'url';
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium text-[#A7B0BE]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        className="min-h-11 w-full rounded-xl border border-[#2A303C] bg-[#0E1117] px-3.5 text-sm text-[#EEF1F6] outline-none transition placeholder:text-[#636E7E] focus:border-[#3B7BFF]/70 focus:ring-2 focus:ring-[#3B7BFF]/15"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium text-[#A7B0BE]">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        rows={rows}
        className="w-full resize-y rounded-xl border border-[#2A303C] bg-[#0E1117] px-3.5 py-3 text-sm leading-6 text-[#EEF1F6] outline-none transition placeholder:text-[#636E7E] focus:border-[#3B7BFF]/70 focus:ring-2 focus:ring-[#3B7BFF]/15"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange, detail }: { label: string; checked: boolean; onChange: (checked: boolean) => void; detail?: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-4 rounded-xl border border-[#2A303C] bg-[#0E1117] px-3.5 py-3 text-left">
      <span>
        <span className="block text-xs font-semibold text-[#E8ECF3]">{label}</span>
        {detail ? <span className="mt-1 block text-[10px] leading-4 text-[#7D8796]">{detail}</span> : null}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-[#3B7BFF]' : 'bg-[#343B48]'}`} aria-checked={checked} role="switch">
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

function InlineNotice({ text, error = false }: { text: string; error?: boolean }) {
  if (!text) return null;
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5 ${error ? 'border-red-400/20 bg-red-500/10 text-red-200' : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'}`} role="status">
      {error ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} /> : <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />}
      <span>{text}</span>
    </div>
  );
}

function LoadingLine() {
  return <div className="flex items-center gap-2 py-8 text-xs text-[#909AAA]"><Loader2 className="h-4 w-4 animate-spin text-[#3B7BFF]" />Yükleniyor</div>;
}

function UserLink({ user }: { user: SummaryUser }) {
  return (
    <a href={telegramProfile(user)} onClick={(event) => openTelegramProfile(user, event)} className="max-w-[190px] truncate font-medium text-[#E5EAF2] hover:text-[#72A1FF]">
      {user.username ? `@${user.username.replace(/^@/, '')}` : user.firstName || user.telegramId}
    </a>
  );
}

function StatCard({ title, value, Icon }: { title: string; value: number; Icon: LucideIcon }) {
  return (
    <div className="rounded-2xl border border-[#252C37] bg-[#12151C] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase leading-4 tracking-[.11em] text-[#8490A1]">{title}</span>
        <Icon className="h-4 w-4 shrink-0 text-[#3B7BFF]" strokeWidth={1.75} />
      </div>
      <p className="mt-3 font-mono text-2xl font-semibold tabular-nums text-[#F1F4F8]">{formatNumber(value)}</p>
    </div>
  );
}

function SummaryTab() {
  const resource = useAdminResource<SummaryResponse>('/api/admin/summary', {
    totals: { totalUsers: 0, totalSessions: 0, activeSessions: 0, newUsersToday: 0, bannedUsers: 0 },
    recentUsers: [], activeUsers: [], mailUsers: [],
  });
  if (resource.loading) return <LoadingLine />;
  if (resource.error) return <InlineNotice text={resource.error} error />;
  const { totals } = resource.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard title="Giriş yapan kullanıcı" value={totals.totalUsers} Icon={Users} />
        <StatCard title="Oluşturulan e-posta" value={totals.totalSessions} Icon={Activity} />
        <StatCard title="Aktif oturum" value={totals.activeSessions} Icon={Clock3} />
        <StatCard title="Bugün yeni kullanıcı" value={totals.newUsersToday} Icon={Users} />
        <StatCard title="Banlı kullanıcı" value={totals.bannedUsers} Icon={Ban} />
      </div>

      <Panel>
        <SectionTitle title="Son kullanan 15 kişi" detail="Kullanıcı adına veya Telegram kimliğine dokunarak profili açın." />
        {resource.data.recentUsers.length === 0 ? <p className="py-5 text-xs text-[#818B9B]">Henüz kullanıcı kaydı yok.</p> : (
          <div className="divide-y divide-[#242B36]">
            {resource.data.recentUsers.map((user) => (
              <div key={user.telegramId} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <UserLink user={user} />
                  <p className="mt-1 font-mono text-[10px] text-[#697586]">{user.telegramId}</p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="rounded-md bg-[#1A202A] px-2 py-1 font-mono text-[10px] uppercase text-[#9AA6B7]">{user.language}</span>
                  <p className="mt-1.5 text-[10px] text-[#758092]">{formatDate(user.lastSeen)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <SectionTitle title="Şu an aktif 3 kişi" detail="Süresi dolmamış en son oturumlar." />
          {resource.data.activeUsers.length === 0 ? <p className="py-4 text-xs text-[#818B9B]">Aktif e-posta oturumu yok.</p> : (
            <div className="space-y-2">
              {resource.data.activeUsers.map((user) => (
                <div key={user.telegramId} className="flex items-center justify-between gap-3 rounded-xl border border-[#252C37] bg-[#0E1117] px-3 py-3">
                  <div className="min-w-0"><UserLink user={user} /><p className="mt-1 text-[10px] text-[#778294]">{user.telegramId}</p></div>
                  <span className="font-mono text-sm tabular-nums text-[#72A1FF]">{formatDuration(user.remainingSeconds)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel>
          <SectionTitle title="Maili gerçekten kullanan son 10 kişi" detail="Yalnızca sayaç ve son e-posta zamanı gösterilir." />
          {resource.data.mailUsers.length === 0 ? <p className="py-4 text-xs text-[#818B9B]">Henüz mail alınmadı.</p> : (
            <div className="space-y-2">
              {resource.data.mailUsers.map((user) => (
                <div key={user.telegramId} className="flex items-center justify-between gap-3 rounded-xl border border-[#252C37] bg-[#0E1117] px-3 py-3">
                  <div className="min-w-0"><UserLink user={user} /><p className="mt-1 text-[10px] text-[#778294]">{formatDate(user.lastMailAt)}</p></div>
                  <span className="shrink-0 rounded-lg bg-[#14223B] px-2.5 py-1.5 font-mono text-xs text-[#8AB0FF]">{formatNumber(user.mailCount ?? 0)} mail</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <div className="flex justify-end"><ActionButton variant="ghost" onClick={resource.reload}><RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />Yenile</ActionButton></div>
    </div>
  );
}

function ChannelsTab({ notify }: { notify: (message: string, isError?: boolean) => void }) {
  const resource = useAdminResource<ChannelResponse>('/api/admin/channels', { channels: [], subscriptionRequired: false });
  const [chatId, setChatId] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [busy, setBusy] = useState(false);

  async function addChannel(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await adminFetch('/api/admin/channels', jsonRequest('POST', { chatId, inviteLink }));
      setChatId('');
      setInviteLink('');
      notify('Kanal eklendi.');
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  async function toggleChannel(channel: ChannelRecord) {
    try {
      await adminFetch(`/api/admin/channels/${channel.id}`, jsonRequest('PATCH', { enabled: !channel.enabled }));
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    }
  }

  async function removeChannel(channel: ChannelRecord) {
    if (!window.confirm(`“${channel.title}” kanalını silmek istiyor musunuz?`)) return;
    try {
      await adminFetch(`/api/admin/channels/${channel.id}`, { method: 'DELETE' });
      notify('Kanal silindi.');
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    }
  }

  async function setSubscription(enabled: boolean) {
    try {
      const result = await adminFetch<{ enabled: boolean }>('/api/admin/subscription', jsonRequest('PUT', { enabled }));
      resource.setData((current) => ({ ...current, subscriptionRequired: result.enabled }));
      notify(enabled ? 'Zorunlu abonelik açıldı.' : 'Zorunlu abonelik kapatıldı.');
    } catch (caught) {
      notify(errorMessage(caught), true);
    }
  }

  if (resource.loading) return <LoadingLine />;
  if (resource.error) return <InlineNotice text={resource.error} error />;
  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle title="Abonelik kapısı" detail="Açıldığında kullanıcılar aktif kanallara katılmadan uygulamayı kullanamaz. Adminler muaftır." />
        <Toggle label="Zorunlu abonelik" checked={resource.data.subscriptionRequired} onChange={(value) => void setSubscription(value)} />
      </Panel>
      <Panel>
        <SectionTitle title="Kanal ekle" detail="Kanalda bot yönetici olmalı. Özel kanallarda -100 ile başlayan kimliği ve davet bağlantısını girin." />
        <form onSubmit={(event) => void addChannel(event)} className="space-y-3">
          <TextField label="Kanal kullanıcı adı veya sohbet kimliği" value={chatId} onChange={setChatId} placeholder="@kanal veya -1001234567890" />
          <TextField label="Özel kanal davet bağlantısı (isteğe bağlı)" value={inviteLink} onChange={setInviteLink} placeholder="https://t.me/+..." />
          <ActionButton type="submit" disabled={busy || !chatId.trim()}><Plus className="h-4 w-4" strokeWidth={1.75} />{busy ? 'Ekleniyor' : 'Kanalı doğrula ve ekle'}</ActionButton>
        </form>
      </Panel>
      <Panel>
        <SectionTitle title="Kanallar" detail={`${resource.data.channels.length} kayıt`} />
        {resource.data.channels.length === 0 ? <p className="py-5 text-xs text-[#818B9B]">Henüz kanal eklenmedi.</p> : (
          <div className="space-y-2">
            {resource.data.channels.map((channel) => (
              <div key={channel.id} className="rounded-xl border border-[#252C37] bg-[#0E1117] p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#E6EAF1]">{channel.title}</p>
                    <p className="mt-1 break-all font-mono text-[10px] text-[#7E899A]">{channel.username ? `@${channel.username}` : channel.chatId}</p>
                    {channel.inviteLink ? <p className="mt-1 break-all text-[10px] text-[#687486]">{channel.inviteLink}</p> : null}
                  </div>
                  <button type="button" onClick={() => void removeChannel(channel)} aria-label="Kanalı sil" className="rounded-lg p-2 text-[#8490A1] hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-4 w-4" strokeWidth={1.75} /></button>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#242B36] pt-3">
                  <span className={`inline-flex items-center gap-1.5 text-[10px] ${channel.error ? 'text-amber-300' : channel.botAdmin ? 'text-emerald-300' : 'text-red-300'}`}>
                    {channel.error ? <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} /> : <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />}
                    {channel.error ? `Hata: ${channel.error}` : channel.botAdmin ? 'Bot yönetici' : 'Bot yönetici değil'}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-[#8590A0]">{channel.enabled ? 'Açık' : 'Kapalı'}</span>
                    <button type="button" onClick={() => void toggleChannel(channel)} className={`relative h-6 w-11 rounded-full transition ${channel.enabled ? 'bg-[#3B7BFF]' : 'bg-[#343B48]'}`} role="switch" aria-checked={channel.enabled} aria-label="Kanalı aç veya kapat">
                      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${channel.enabled ? 'left-6' : 'left-1'}`} />
                    </button>
                  </div>
                </div>
                {channel.error ? <p className="mt-2 text-[10px] leading-4 text-amber-200/80">{channel.error}</p> : null}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end"><ActionButton variant="ghost" onClick={resource.reload}><RefreshCw className="h-3.5 w-3.5" />Durumu yenile</ActionButton></div>
      </Panel>
    </div>
  );
}

function AnnouncementStatus({ status }: { status: string }) {
  const labels: Record<string, string> = {
    draft: 'Taslak',
    sending: 'Gönderiliyor',
    finished: 'Tamamlandı',
    failed: 'Başarısız',
  };
  const label = labels[status] || status;
  return <span className={`rounded-md px-2 py-1 font-mono text-[9px] uppercase tracking-wide ${status === 'sending' ? 'bg-blue-500/10 text-blue-300' : status === 'finished' ? 'bg-emerald-500/10 text-emerald-300' : status === 'failed' ? 'bg-red-500/10 text-red-300' : 'bg-[#252C37] text-[#A4AFBF]'}`}>{label}</span>;
}

function AnnouncementsTab({ notify }: { notify: (message: string, isError?: boolean) => void }) {
  const list = useAdminResource<AnnouncementListResponse>('/api/admin/announcements', { announcements: [] });
  const [text, setText] = useState('');
  const [parseHtml, setParseHtml] = useState(false);
  const [targetLang, setTargetLang] = useState<'all' | 'tr' | 'ru' | 'en'>('all');
  const [buttonText, setButtonText] = useState('');
  const [buttonUrl, setButtonUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [progress, setProgress] = useState<AnnouncementProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAudience, setConfirmAudience] = useState<number | null>(null);
  const [loadAnnouncementId, setLoadAnnouncementId] = useState('');
  const captionWarning = files.length > 0 && text.length > 1024;

  useEffect(() => {
    if (!announcement?.id || announcement.status !== 'sending') return;
    let active = true;
    const updateProgress = async () => {
      try {
        const next = await adminFetch<AnnouncementProgress>(`/api/admin/announcements/${announcement.id}/progress`);
        if (!active) return;
        setProgress(next);
        setAnnouncement((current) => current ? { ...current, status: next.status, total: next.total, sent: next.sent, failed: next.failed, blocked: next.blocked } : current);
      } catch {
        if (active) setProgress(null);
      }
    };
    void updateProgress();
    const timer = window.setInterval(() => void updateProgress(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [announcement?.id, announcement?.status]);

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'video/mp4']);
    if (selected.length + files.length > 10) {
      notify('En fazla 10 fotoğraf veya video ekleyebilirsiniz.', true);
      return;
    }
    if (selected.some((file) => !allowedTypes.has(file.type))) {
      notify('Yalnızca JPEG, PNG ve MP4 dosyaları kabul edilir.', true);
      return;
    }
    if (selected.some((file) => file.size > 50 * 1024 * 1024)) {
      notify('Her dosya en fazla 50 MB olabilir.', true);
      return;
    }
    if ([...files, ...selected].reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
      notify('Toplam yükleme boyutu 100 MB sınırını aşamaz.', true);
      return;
    }
    setFiles((current) => [...current, ...selected]);
  }

  async function sendTest() {
    if (!text.trim() && files.length === 0) {
      notify('Duyuru metni veya en az bir medya ekleyin.', true);
      return;
    }
    if (text.length > 4096) {
      notify('Duyuru metni 4096 karakteri aşamaz.', true);
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('text', text);
      form.append('parseHtml', String(parseHtml));
      form.append('targetLang', targetLang);
      form.append('buttonText', buttonText);
      form.append('buttonUrl', buttonUrl);
      files.forEach((file) => form.append('media', file));
      const created = await adminFetch<Announcement>('/api/admin/announcements/test', { method: 'POST', body: form });
      setAnnouncement(created);
      setProgress(null);
      setFiles([]);
      notify('Test mesajı gönderildi ve duyuru kaydedildi.');
      list.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  async function openAnnouncement(id: string) {
    setLoadAnnouncementId(id);
    try {
      const selected = await adminFetch<Announcement>(`/api/admin/announcements/${id}`);
      setAnnouncement(selected);
      setProgress(null);
      setText(selected.text);
      setParseHtml(selected.parseHtml);
      setTargetLang(selected.targetLang);
      setButtonText(selected.buttonText ?? '');
      setButtonUrl(selected.buttonUrl ?? '');
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setLoadAnnouncementId('');
    }
  }

  async function prepareSend() {
    if (!announcement) return;
    setBusy(true);
    try {
      const updated = await adminFetch<Announcement>(
        `/api/admin/announcements/${announcement.id}`,
        jsonRequest('PUT', { text, parseHtml, buttonText, buttonUrl, targetLang }),
      );
      setAnnouncement(updated);
      const audience = await adminFetch<{ recipients: number }>(`/api/admin/announcements/${announcement.id}/audience`);
      setConfirmAudience(audience.recipients);
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSend() {
    if (!announcement) return;
    setBusy(true);
    try {
      const response = await adminFetch<{ ok: boolean; total: number; status: string }>(
        `/api/admin/announcements/${announcement.id}/send`,
        jsonRequest('POST', { confirm: true }),
      );
      setAnnouncement((current) => current ? { ...current, status: response.status, total: response.total, sent: 0, failed: 0, blocked: 0 } : current);
      setProgress({ id: announcement.id, status: response.status, total: response.total, sent: 0, failed: 0, blocked: 0, finishedAt: null, percent: 0 });
      setConfirmAudience(null);
      notify('Toplu gönderim başlatıldı.');
      list.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  if (list.loading) return <LoadingLine />;
  if (list.error) return <InlineNotice text={list.error} error />;
  const activeProgress = progress ?? (announcement ? {
    id: announcement.id,
    status: announcement.status,
    total: announcement.total,
    sent: announcement.sent,
    failed: announcement.failed,
    blocked: announcement.blocked,
    finishedAt: announcement.finishedAt ?? null,
    percent: announcement.total ? Math.floor(((announcement.sent + announcement.failed + announcement.blocked) / announcement.total) * 100) : announcement.status === 'finished' ? 100 : 0,
  } : null);

  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle title="Duyuru oluştur" detail="Telegram bot sohbetlerinden gönderilir. Test gönderimi, medya file_id değerlerini kalıcı olarak kaydeder." />
        <div className="space-y-3">
          <TextArea label={`Metin (${text.length}/4096)`} value={text} onChange={setText} maxLength={4096} rows={6} placeholder="Duyuru metnini yazın" />
          {captionWarning ? <p className="-mt-1 text-[10px] leading-4 text-amber-300">Medya altyazısı 1024 karakterle sınırlıdır. Daha uzun metin medyanın ardından ayrı bir mesaj olarak gönderilir.</p> : null}
          <Toggle label="HTML biçimi" checked={parseHtml} onChange={setParseHtml} detail="Telegram HTML etiketlerini yorumlar." />
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-[#A7B0BE]">Fotoğraf veya video (en fazla 10 dosya, dosya başı 50 MB)</span>
            <input type="file" accept="image/jpeg,image/png,video/mp4" multiple onChange={(event) => void chooseFiles(event)} className="block w-full text-xs text-[#9CA7B7] file:mr-3 file:rounded-lg file:border-0 file:bg-[#1A202A] file:px-3 file:py-2.5 file:text-xs file:font-medium file:text-[#D7DEE8]" />
          </label>
          {files.length > 0 ? <div className="space-y-1.5">{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center justify-between rounded-lg bg-[#0E1117] px-3 py-2 text-[10px] text-[#9CA7B7]"><span className="truncate">{file.name}</span><button type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label="Dosyayı kaldır" className="ml-2 rounded p-1 text-[#8B96A6] hover:text-red-300"><X className="h-3.5 w-3.5" /></button></div>)}</div> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Buton yazısı (isteğe bağlı)" value={buttonText} onChange={setButtonText} maxLength={64} placeholder="Daha fazla bilgi" />
            <TextField label="Buton bağlantısı (http/https/tg://)" value={buttonUrl} onChange={setButtonUrl} placeholder="https://example.com" />
          </div>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-[#A7B0BE]">Hedef dil</span>
            <select value={targetLang} onChange={(event) => setTargetLang(event.currentTarget.value as typeof targetLang)} className="min-h-11 w-full rounded-xl border border-[#2A303C] bg-[#0E1117] px-3.5 text-sm text-[#EEF1F6] outline-none focus:border-[#3B7BFF]/70">
              <option value="all">Hepsi</option><option value="tr">Türkçe</option><option value="ru">Rusça</option><option value="en">İngilizce</option>
            </select>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ActionButton onClick={() => void sendTest()} disabled={busy || (!text.trim() && files.length === 0)} className="flex-1"><BellRing className="h-4 w-4" strokeWidth={1.75} />{busy ? 'Gönderiliyor' : 'Kendime test gönder'}</ActionButton>
            {announcement ? <ActionButton variant="secondary" onClick={() => void prepareSend()} disabled={busy || announcement.status === 'sending' || announcement.status === 'finished'} className="flex-1"><ArrowUpRight className="h-4 w-4" strokeWidth={1.75} />Herkese gönder</ActionButton> : null}
          </div>
        </div>
      </Panel>

      {announcement ? (
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><SectionTitle title={`Duyuru #${announcement.id}`} detail={announcement.media.length ? `${announcement.media.length} medya dosyası kaydedildi` : 'Medya yok'} /></div>
            <AnnouncementStatus status={announcement.status} />
          </div>
          {activeProgress ? (
            <>
              <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-[#99A4B4]"><span>{formatNumber(activeProgress.sent + activeProgress.failed + activeProgress.blocked)} / {formatNumber(activeProgress.total)}</span><span>{activeProgress.percent}%</span></div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#252C37]"><div className="h-full rounded-full bg-[#3B7BFF] transition-all duration-300" style={{ width: `${Math.max(0, Math.min(100, activeProgress.percent))}%` }} /></div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-[#0E1117] px-2 py-2"><p className="font-mono text-sm text-emerald-300">{formatNumber(activeProgress.sent)}</p><p className="mt-1 text-[9px] text-[#7F8A9B]">Gönderildi</p></div>
                <div className="rounded-lg bg-[#0E1117] px-2 py-2"><p className="font-mono text-sm text-red-300">{formatNumber(activeProgress.failed)}</p><p className="mt-1 text-[9px] text-[#7F8A9B]">Başarısız</p></div>
                <div className="rounded-lg bg-[#0E1117] px-2 py-2"><p className="font-mono text-sm text-amber-300">{formatNumber(activeProgress.blocked)}</p><p className="mt-1 text-[9px] text-[#7F8A9B]">Engellemiş</p></div>
              </div>
              {activeProgress.status === 'finished' ? <p className="mt-3 text-[10px] text-[#8D98A8]">Tamamlanma: {formatDate(activeProgress.finishedAt)}</p> : null}
            </>
          ) : null}
        </Panel>
      ) : null}

      <Panel>
        <SectionTitle title="Önceki duyurular" />
        {list.data.announcements.length === 0 ? <p className="py-4 text-xs text-[#818B9B]">Henüz duyuru yok.</p> : (
          <div className="space-y-2">
            {list.data.announcements.map((item) => (
              <button type="button" key={item.id} onClick={() => void openAnnouncement(item.id)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#252C37] bg-[#0E1117] p-3 text-left hover:border-[#3B7BFF]/40">
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-[#DCE2EB]">#{item.id} · {item.text || 'Medya duyurusu'}</span><span className="mt-1 block text-[9px] text-[#778294]">{formatDate(item.createdAt)} · {item.targetLang.toUpperCase()}</span></span>
                <span className="flex shrink-0 items-center gap-2"><AnnouncementStatus status={item.status} /><ChevronRight className="h-4 w-4 text-[#738094]" /></span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      {confirmAudience !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <section className="w-full max-w-sm rounded-2xl border border-[#2A303C] bg-[#12151C] p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="announcement-confirm-title">
            <h2 id="announcement-confirm-title" className="font-mono text-sm font-semibold text-white">Toplu gönderim onayı</h2>
            <p className="mt-3 text-sm leading-6 text-[#AAB4C2]">{formatNumber(confirmAudience)} kişiye gönderilecek, emin misin?</p>
            <div className="mt-5 grid grid-cols-2 gap-2"><ActionButton variant="secondary" onClick={() => setConfirmAudience(null)}>Vazgeç</ActionButton><ActionButton onClick={() => void confirmSend()} disabled={busy}>{busy ? 'Başlatılıyor' : 'Gönder'}</ActionButton></div>
          </section>
        </div>
      ) : null}
      {loadAnnouncementId ? <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 text-xs text-white"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Duyuru yükleniyor</div> : null}
    </div>
  );
}

function ChannelsProfileNote() {
  return <p className="mt-3 text-[10px] leading-4 text-[#758093]">Telegram profil bağlantıları yeni sekmede açılır. Bot engeli olan kullanıcılar duyurudan otomatik çıkarılır.</p>;
}

function BansTab({ notify }: { notify: (message: string, isError?: boolean) => void }) {
  const resource = useAdminResource<BanResponse>('/api/admin/bans', { users: [] });
  const [telegramId, setTelegramId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function banUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await adminFetch('/api/admin/bans', jsonRequest('POST', { telegramId, reason }));
      setTelegramId('');
      setReason('');
      notify('Kullanıcı banlandı.');
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  async function unban(user: BannedUser) {
    if (!window.confirm(`${user.telegramId} kimlikli kullanıcının banını kaldırmak istiyor musunuz?`)) return;
    try {
      await adminFetch(`/api/admin/bans/${user.telegramId}`, { method: 'DELETE' });
      notify('Ban kaldırıldı.');
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    }
  }

  if (resource.loading) return <LoadingLine />;
  if (resource.error) return <InlineNotice text={resource.error} error />;
  return (
    <div className="space-y-4">
      <Panel>
        <SectionTitle title="Kullanıcıyı banla" detail="Telegram kullanıcı kimliğini girin. Kullanıcı bot mesajlarından ve Mini App API isteklerinden engellenir." />
        <form onSubmit={(event) => void banUser(event)} className="space-y-3">
          <TextField label="Telegram kullanıcı kimliği" value={telegramId} onChange={setTelegramId} inputMode="numeric" placeholder="123456789" />
          <TextArea label="Sebep (isteğe bağlı)" value={reason} onChange={setReason} maxLength={300} rows={2} placeholder="Yönetici notu" />
          <ActionButton type="submit" disabled={busy || !telegramId.trim()} variant="danger"><Ban className="h-4 w-4" strokeWidth={1.75} />{busy ? 'Kaydediliyor' : 'Banla'}</ActionButton>
        </form>
      </Panel>
      <Panel>
        <SectionTitle title={`Banlı kullanıcılar (${resource.data.users.length})`} />
        {resource.data.users.length === 0 ? <p className="py-4 text-xs text-[#818B9B]">Banlı kullanıcı yok.</p> : (
          <div className="space-y-2">
            {resource.data.users.map((user) => (
              <div key={user.telegramId} className="rounded-xl border border-[#252C37] bg-[#0E1117] p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate text-sm font-semibold text-[#E4E9F0]">{user.username ? `@${user.username}` : user.firstName || user.telegramId}</p><p className="mt-1 font-mono text-[10px] text-[#758093]">{user.telegramId} · {user.language.toUpperCase()}</p></div>
                  <ActionButton variant="secondary" onClick={() => void unban(user)} className="min-h-9 shrink-0 px-2.5">Banı kaldır</ActionButton>
                </div>
                {user.reason ? <p className="mt-2 text-xs leading-5 text-[#A0AABB]">{user.reason}</p> : null}
                <p className="mt-2 text-[9px] text-[#697586]">Ban tarihi: {formatDate(user.bannedAt)}</p>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <ChannelsProfileNote />
    </div>
  );
}

async function compressImage(file: File, maxSide: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  let width = Math.min(bitmap.width, maxSide);
  let height = Math.min(bitmap.height, maxSide);
  const scale = Math.min(1, maxSide / bitmap.width, maxSide / bitmap.height);
  width = Math.max(1, Math.round(bitmap.width * scale));
  height = Math.max(1, Math.round(bitmap.height * scale));
  let quality = 0.86;
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Görsel dönüştürülemedi.');
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 300 * 1024) break;
    if (quality > 0.52) quality -= 0.08;
    else {
      width = Math.max(1, Math.floor(width * 0.85));
      height = Math.max(1, Math.floor(height * 0.85));
      quality = 0.8;
    }
  }
  bitmap.close();
  if (!blob || blob.size > 300 * 1024) throw new Error('Görsel 300 KB altına küçültülemedi.');
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Görsel okunamadı.'));
    reader.onerror = () => reject(new Error('Görsel okunamadı.'));
    reader.readAsDataURL(blob!);
  });
}

function AdsTab({ notify }: { notify: (message: string, isError?: boolean) => void }) {
  const resource = useAdminResource<AdResponse>('/api/admin/ads', { ads: [] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [buttonText, setButtonText] = useState('');
  const [active, setActive] = useState(true);
  const [imageData, setImageData] = useState<string | null>(null);
  const [logoData, setLogoData] = useState<string | null>(null);
  const [imageChanged, setImageChanged] = useState(false);
  const [logoChanged, setLogoChanged] = useState(false);
  const [busy, setBusy] = useState(false);

  function resetForm() {
    setEditingId(null);
    setTitle(''); setText(''); setLinkUrl(''); setButtonText(''); setActive(true);
    setImageData(null); setLogoData(null); setImageChanged(false); setLogoChanged(false);
  }

  function editAd(ad: AdRecord) {
    setEditingId(ad.id);
    setTitle(ad.title);
    setText(ad.text);
    setLinkUrl(ad.linkUrl);
    setButtonText(ad.buttonText);
    setActive(ad.active);
    setImageData(ad.hasImage ? `/api/ads/${ad.id}/image` : null);
    setLogoData(ad.hasLogo ? `/api/ads/${ad.id}/logo` : null);
    setImageChanged(false);
    setLogoChanged(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function onImageSelected(event: ChangeEvent<HTMLInputElement>, kind: 'image' | 'logo') {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notify('Yalnızca görsel dosyası seçin.', true);
      return;
    }
    setBusy(true);
    try {
      const result = await compressImage(file, kind === 'image' ? 1000 : 160);
      if (kind === 'image') { setImageData(result); setImageChanged(true); }
      else { setLogoData(result); setLogoChanged(true); }
      notify(kind === 'image' ? 'Reklam görseli küçültüldü.' : 'Logo küçültüldü.');
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  async function saveAd(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || text.length > 140 || !linkUrl.trim()) {
      notify('Başlık, bağlantı ve en fazla 140 karakterlik metin girin.', true);
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = { title, text, linkUrl, buttonText, active };
    if (imageChanged) body.image = imageData;
    if (logoChanged) body.logo = logoData;
    try {
      if (editingId) await adminFetch(`/api/admin/ads/${editingId}`, jsonRequest('PUT', body));
      else await adminFetch('/api/admin/ads', jsonRequest('POST', body));
      notify(editingId ? 'Reklam güncellendi.' : 'Reklam oluşturuldu.');
      resetForm();
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    } finally {
      setBusy(false);
    }
  }

  async function removeAd(ad: AdRecord) {
    if (!window.confirm(`“${ad.title}” reklamını silmek istiyor musunuz?`)) return;
    try {
      await adminFetch(`/api/admin/ads/${ad.id}`, { method: 'DELETE' });
      if (editingId === ad.id) resetForm();
      notify('Reklam silindi.');
      resource.reload();
    } catch (caught) {
      notify(errorMessage(caught), true);
    }
  }

  if (resource.loading) return <LoadingLine />;
  if (resource.error) return <InlineNotice text={resource.error} error />;
  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex items-start justify-between gap-3"><SectionTitle title={editingId ? `Reklam düzenle #${editingId}` : 'Reklam oluştur'} detail="Görseller tarayıcıda küçültülür ve JPEG olarak kaydedilir; hedef boyut 300 KB altıdır." />{editingId ? <button type="button" onClick={resetForm} aria-label="Düzenlemeyi kapat" className="rounded-lg p-2 text-[#8B96A6] hover:bg-[#202631] hover:text-white"><X className="h-4 w-4" /></button> : null}</div>
        <form onSubmit={(event) => void saveAd(event)} className="space-y-3">
          <TextField label="Başlık" value={title} onChange={setTitle} maxLength={100} placeholder="Ürün veya hizmet adı" />
          <TextArea label={`Metin (${text.length}/140)`} value={text} onChange={setText} maxLength={140} rows={3} placeholder="Kısa reklam metni" />
          <TextField label="Bağlantı" value={linkUrl} onChange={setLinkUrl} placeholder="https://example.com" />
          <TextField label="Buton yazısı" value={buttonText} onChange={setButtonText} maxLength={40} placeholder="İncele" />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5"><span className="text-[11px] font-medium text-[#A7B0BE]">Reklam fotoğrafı, en fazla 1000 px</span><input type="file" accept="image/*" onChange={(event) => void onImageSelected(event, 'image')} className="block w-full text-[10px] text-[#99A4B4] file:mr-2 file:rounded-lg file:border-0 file:bg-[#1A202A] file:px-2.5 file:py-2 file:text-[10px] file:text-[#D7DEE8]" /></label>
            <label className="block space-y-1.5"><span className="text-[11px] font-medium text-[#A7B0BE]">Logo, en fazla 160 × 160 px</span><input type="file" accept="image/*" onChange={(event) => void onImageSelected(event, 'logo')} className="block w-full text-[10px] text-[#99A4B4] file:mr-2 file:rounded-lg file:border-0 file:bg-[#1A202A] file:px-2.5 file:py-2 file:text-[10px] file:text-[#D7DEE8]" /></label>
          </div>
          {imageData ? <div className="relative overflow-hidden rounded-xl border border-[#2A303C] bg-[#0E1117]"><img src={imageData} alt="Reklam görseli önizlemesi" className="max-h-44 w-full object-cover" /><button type="button" onClick={() => { setImageData(null); setImageChanged(true); }} className="absolute right-2 top-2 rounded-lg bg-black/70 p-2 text-white"><Trash2 className="h-4 w-4" /></button></div> : null}
          {logoData ? <div className="flex items-center gap-3 rounded-xl border border-[#2A303C] bg-[#0E1117] p-3"><img src={logoData} alt="Logo önizlemesi" className="h-12 w-12 rounded-lg object-cover" /><button type="button" onClick={() => { setLogoData(null); setLogoChanged(true); }} className="text-xs text-red-300">Logoyu kaldır</button></div> : null}
          <Toggle label="Reklam aktif" checked={active} onChange={setActive} detail="Aktif reklamlardan biri kullanıcıya rastgele gösterilir." />
          <div className="flex gap-2"><ActionButton type="submit" disabled={busy || !title.trim() || !linkUrl.trim()} className="flex-1"><Save className="h-4 w-4" strokeWidth={1.75} />{busy ? 'Kaydediliyor' : editingId ? 'Değişiklikleri kaydet' : 'Reklam oluştur'}</ActionButton>{editingId ? <ActionButton variant="secondary" onClick={resetForm}>Vazgeç</ActionButton> : null}</div>
        </form>
      </Panel>

      <Panel>
        <SectionTitle title={`Reklamlar (${resource.data.ads.length})`} />
        {resource.data.ads.length === 0 ? <p className="py-4 text-xs text-[#818B9B]">Henüz reklam oluşturulmadı.</p> : (
          <div className="space-y-2">
            {resource.data.ads.map((ad) => (
              <div key={ad.id} className="flex items-center gap-3 rounded-xl border border-[#252C37] bg-[#0E1117] p-3">
                {ad.hasLogo ? <img src={`/api/ads/${ad.id}/logo`} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#19202C] text-[#6C85AE]"><ImagePlus className="h-4 w-4" strokeWidth={1.75} /></span>}
                <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[#E3E8EF]">{ad.title}</p><p className="mt-1 truncate text-[10px] text-[#7F8A9A]">{ad.views} görüntülenme · {ad.clicks} tıklama</p></div>
                <span className={`rounded-md px-2 py-1 text-[9px] ${ad.active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-[#252C37] text-[#929DAD]'}`}>{ad.active ? 'Aktif' : 'Kapalı'}</span>
                <button type="button" onClick={() => editAd(ad)} aria-label="Reklamı düzenle" className="rounded-lg p-2 text-[#9AA5B4] hover:bg-[#202631] hover:text-white"><Save className="h-4 w-4" strokeWidth={1.75} /></button>
                <button type="button" onClick={() => void removeAd(ad)} aria-label="Reklamı sil" className="rounded-lg p-2 text-[#9AA5B4] hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-4 w-4" strokeWidth={1.75} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end"><ActionButton variant="ghost" onClick={resource.reload}><RefreshCw className="h-3.5 w-3.5" />Sayaçları yenile</ActionButton></div>
      </Panel>
    </div>
  );
}

function AdminApp() {
  const [tab, setTab] = useState<AdminTab>('summary');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  function notify(text: string, error = false) {
    setNotice({ text, error });
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  }

  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current); }, []);
  const activeTab = useMemo(() => tabs.find((item) => item.id === tab) ?? tabs[0]!, [tab]);

  return (
    <div className="admin-shell min-h-[100dvh] bg-[#0B0D12] text-[#EEF1F6]">
      <header className="sticky top-0 z-20 border-b border-[#202631] bg-[#0B0D12]/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#3B7BFF]/25 bg-[#3B7BFF]/10 text-[#6D9CFF]"><ShieldCheck className="h-4 w-4" strokeWidth={1.75} /></span><div><p className="font-mono text-sm font-semibold tracking-[.12em]">JNT <span className="text-[#3B7BFF]">ADMIN</span></p><p className="text-[9px] uppercase tracking-[.14em] text-[#718095]">Yönetim paneli</p></div></div>
          <a href="/" className="inline-flex items-center gap-1.5 rounded-lg border border-[#29313D] px-3 py-2 text-[10px] text-[#AAB4C2] hover:bg-[#171C25]"><ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />Uygulamaya dön</a>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-[calc(92px+env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pt-7">
        <div className="mb-5 flex items-end justify-between gap-3"><div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-[#647185]">Yönetim</p><h1 className="mt-1 font-mono text-xl font-semibold text-white">{activeTab.title}</h1></div><span className="rounded-lg border border-[#252C37] bg-[#12151C] px-2.5 py-1.5 font-mono text-[9px] uppercase text-[#8793A4]">Yalnızca Türkçe</span></div>
        {tab === 'summary' ? <SummaryTab /> : null}
        {tab === 'announcements' ? <AnnouncementsTab notify={notify} /> : null}
        {tab === 'channels' ? <ChannelsTab notify={notify} /> : null}
        {tab === 'bans' ? <BansTab notify={notify} /> : null}
        {tab === 'ads' ? <AdsTab notify={notify} /> : null}
      </main>

      {notice ? <div className={`fixed bottom-[calc(78px+env(safe-area-inset-bottom))] left-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl border px-4 py-3 text-xs shadow-2xl ${notice.error ? 'border-red-400/20 bg-[#271517] text-red-200' : 'border-[#3B7BFF]/30 bg-[#14213A] text-[#E6EEFF]'}`} role="status">{notice.text}</div> : null}

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[#252C37] bg-[#101319]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur" aria-label="Yönetim sekmeleri">
        <div className="mx-auto grid max-w-2xl grid-cols-5 px-1.5 pt-2">
          {tabs.map(({ id, title, Icon }) => (
            <button key={id} type="button" onClick={() => { setTab(id); setNotice(null); }} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-[9px] transition ${tab === id ? 'text-[#70A0FF]' : 'text-[#778395] hover:text-[#D4DBE5]'}`} aria-current={tab === id ? 'page' : undefined}>
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              <span>{title}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

export default AdminApp;
