import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clipboard,
  Clock3,
  Globe2,
  Inbox,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  getGetMailInboxQueryKey,
  getGetMailMessageQueryKey,
  getGetMailSessionQueryKey,
  useCreateMailSession,
  useGetMailInbox,
  useGetMailMessage,
  useGetMailSession,
  useRefreshMailSession,
  useUpdateMailLanguage,
  type MailMessage,
  type MailSession,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { JaiPanel } from '@/components/jai-panel';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { copy, localeLabels, type Copy, type Locale } from '@/lib/locales';
import { getTelegramWebApp, prepareTelegramWebApp, type TelegramWebApp } from '@/lib/telegram';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const LazyAdminApp = lazy(() => import('@/admin/AdminApp'));

function IconMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_0_28px_hsl(211_100%_62%/.2)]" aria-hidden="true">
      <Mail className="h-[17px] w-[17px]" strokeWidth={2.2} />
    </span>
  );
}

function Button({
  children,
  className = '',
  variant = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const variants = {
    primary: 'bg-primary text-primary-foreground hover:brightness-110 shadow-[0_8px_24px_hsl(211_100%_62%/.15)]',
    secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-[hsl(223_30%_18%)]',
    ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
    danger: 'border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2.5 text-[13px] font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse-soft rounded bg-secondary ${className}`} />;
}

function formatCountdown(expiresAt?: string, now = Date.now()) {
  if (!expiresAt) return { label: '10:00', expired: false, urgent: false, seconds: 600 };
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  return {
    label: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    expired: seconds === 0,
    urgent: seconds > 0 && seconds <= 120,
    seconds,
  };
}

function useCountdown(expiresAt?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return formatCountdown(expiresAt, now);
}

function formatReceived(date: string, locale: Locale, c: Copy) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000);
  if (seconds < 60) return c.justNow;
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(parsed);
}

function getTelegramAuthorization() {
  const initData = getTelegramWebApp()?.initData;
  return `tma ${initData || 'preview'}`;
}

function supportsCloudStorage(telegram: TelegramWebApp | undefined) {
  return Boolean(telegram?.CloudStorage && (telegram.isVersionAtLeast?.('6.9') ?? false));
}

function getInitialLocale(): Locale {
  const stored = window.localStorage.getItem('jnt-mail-language');
  if (stored === 'tr' || stored === 'ru' || stored === 'en') return stored;
  const language = getTelegramWebApp()?.initDataUnsafe?.user?.language_code;
  return language === 'tr' ? 'tr' : language === 'ru' ? 'ru' : 'en';
}

function telegramHaptic(kind: 'success' | 'error' | 'light' = 'light') {
  const haptic = getTelegramWebApp()?.HapticFeedback;
  if (kind === 'light') haptic?.impactOccurred?.('light');
  else haptic?.notificationOccurred?.(kind);
}

type GateChannel = {
  id: string;
  chatId: string;
  username: string | null;
  title: string;
  inviteLink: string | null;
  enabled: boolean;
  joined: boolean;
  error: boolean;
};

type GateStatus = {
  banned: boolean;
  isAdmin?: boolean;
  subscriptionRequired: boolean;
  subscribed: boolean;
  channels: GateChannel[];
  supportUrl?: string;
};

type PublicAd = {
  id: string;
  title: string;
  text: string;
  linkUrl: string;
  buttonText: string;
  imageUrl: string | null;
  logoUrl: string | null;
};

async function getGateStatus(): Promise<GateStatus> {
  const response = await fetch('/api/gate/status', {
    headers: { Authorization: getTelegramAuthorization() },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'gate_unavailable');
  return payload as GateStatus;
}

function GateFailure({ c, onRetry }: { c: Copy; onRetry: () => void }) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-5">
      <div className="app-grid pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-50" />
      <section className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-2xl animate-slide-up">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary"><ShieldCheck className="h-5 w-5" strokeWidth={1.75} /></span>
        <h1 className="mt-5 font-mono text-base font-medium text-foreground">{c.gateUnavailable}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{c.gateError}</p>
        <Button variant="primary" className="mt-6 w-full" onClick={onRetry}><RefreshCw className="h-4 w-4" />{c.retry}</Button>
      </section>
    </main>
  );
}

let configuredSupportUrl = 'https://t.me/Azerjnt';
function openSupport() {
  const url = configuredSupportUrl;
  const telegram = getTelegramWebApp();
  if (telegram?.openTelegramLink) telegram.openTelegramLink(url);
  else if (telegram?.openLink) telegram.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function BanScreen({ c }: { c: Copy }) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-5">
      <div className="app-grid pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-50" />
      <section className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-7 text-center shadow-2xl animate-slide-up">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive"><AlertTriangle className="h-5 w-5" strokeWidth={1.75} /></span>
        <h1 className="mt-5 font-mono text-lg font-medium text-foreground">{c.bannedTitle}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{c.bannedDetail}</p>
        <Button variant="secondary" className="mt-5 w-full" onClick={openSupport}>{c.supportContact}</Button>
      </section>
    </main>
  );
}

function SubscriptionGate({
  status,
  c,
  onRecheck,
  checking,
  checkError,
}: {
  status: GateStatus;
  c: Copy;
  onRecheck: () => void;
  checking: boolean;
  checkError: boolean;
}) {
  const channels = status.channels.filter((channel) => !channel.joined && !channel.error);
  function joinChannel(channel: GateChannel) {
    const url = channel.inviteLink || (channel.username ? `https://t.me/${channel.username.replace(/^@/, '')}` : null);
    if (!url) return;
    const telegram = getTelegramWebApp();
    if (telegram?.openTelegramLink) telegram.openTelegramLink(url);
    else if (telegram?.openLink) telegram.openLink(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-4 py-8">
      <div className="app-grid pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-50" />
      <section className="relative w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl animate-slide-up sm:p-7">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary"><ShieldCheck className="h-5 w-5" strokeWidth={1.75} /></span>
        <h1 className="mt-5 font-mono text-lg font-medium text-foreground">{c.gateTitle}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{c.gateDetail}</p>
        <div className="mt-6 space-y-2">
          {channels.map((channel) => {
            const canJoin = Boolean(channel.inviteLink || channel.username);
            return (
              <div key={channel.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 py-3">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{channel.title}</span>
                <Button variant="secondary" className="shrink-0 px-3 py-2" onClick={() => joinChannel(channel)} disabled={!canJoin}>
                  {c.joinChannel}<ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Button>
              </div>
            );
          })}
        </div>
        {checkError ? <p className="mt-3 text-xs text-destructive" role="alert">{c.gateUnavailable}</p> : null}
        <Button variant="primary" className="mt-6 min-h-12 w-full" onClick={onRecheck} disabled={checking}>
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" strokeWidth={1.75} />}
          {checking ? c.checkingMembership : c.recheck}
        </Button>
      </section>
    </main>
  );
}

function GateProtectedHome() {
  const locale = getInitialLocale();
  const c = copy[locale];
  const queryClient = useQueryClient();
  const gateQuery = useQuery({
    queryKey: ['user-gate-status'],
    queryFn: getGateStatus,
    retry: false,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);

  async function recheck() {
    setChecking(true);
    setCheckError(false);
    try {
      const response = await fetch('/api/gate/recheck', {
        method: 'POST',
        headers: { Authorization: getTelegramAuthorization() },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error('gate_recheck_failed');
      queryClient.setQueryData(['user-gate-status'], payload as GateStatus);
      telegramHaptic('success');
    } catch {
      setCheckError(true);
      telegramHaptic('error');
    } finally {
      setChecking(false);
    }
  }

  if (gateQuery.isLoading) {
    return (
      <main className="relative flex min-h-[100dvh] items-center justify-center bg-background px-5">
        <div className="flex items-center gap-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin text-primary" />{c.loading}</div>
      </main>
    );
  }
  if (gateQuery.isError || !gateQuery.data) return <GateFailure c={c} onRetry={() => void gateQuery.refetch()} />;
  if (gateQuery.data.supportUrl) configuredSupportUrl = gateQuery.data.supportUrl;
  if (gateQuery.data.banned) return <BanScreen c={c} />;
  if (gateQuery.data.subscriptionRequired && !gateQuery.data.subscribed) {
    return <SubscriptionGate status={gateQuery.data} c={c} onRecheck={() => void recheck()} checking={checking} checkError={checkError} />;
  }
  return <Home isAdmin={gateQuery.data.isAdmin === true} />;
}

function AdvertisementCard({ locale }: { locale: Locale }) {
  const adQuery = useQuery({
    queryKey: ['public-ad'],
    queryFn: async () => {
      const response = await fetch('/api/ads/public');
      if (!response.ok) throw new Error('ad_unavailable');
      return await response.json() as { ad: PublicAd | null };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const ad = adQuery.data?.ad;

  useEffect(() => {
    if (!ad || !cardRef.current || typeof IntersectionObserver === 'undefined') return;
    const storageKey = `jnt-mail-ad-viewed-${ad.id}`;
    try {
      if (window.sessionStorage.getItem(storageKey)) return;
    } catch {
      // If storage is unavailable, this mounted card still records one impression.
    }
    let recorded = false;
    const observer = new IntersectionObserver((entries) => {
      if (recorded || !entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return;
      recorded = true;
      observer.disconnect();
      try { window.sessionStorage.setItem(storageKey, '1'); } catch { /* Storage is optional. */ }
      void fetch(`/api/ads/${ad.id}/view`, {
        method: 'POST',
        headers: { Authorization: getTelegramAuthorization() },
      }).catch(() => undefined);
    }, { threshold: 0.5 });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [ad?.id]);

  function openAd() {
    if (!ad) return;
    void fetch(`/api/ads/${ad.id}/click`, {
      method: 'POST',
      headers: { Authorization: getTelegramAuthorization() },
    }).catch(() => undefined);
    const telegram = getTelegramWebApp();
    if (telegram?.openLink) telegram.openLink(ad.linkUrl);
    else window.open(ad.linkUrl, '_blank', 'noopener,noreferrer');
  }

  if (adQuery.isLoading) {
    return <div className="mt-5 h-[232px] animate-pulse-soft rounded-2xl border border-border bg-card" aria-hidden="true" />;
  }
  if (!ad) return null;
  return (
    <button
      ref={cardRef}
      type="button"
      onClick={openAd}
      className="group mt-5 block min-h-[232px] w-full overflow-hidden rounded-2xl border border-border bg-card text-left transition-all duration-200 hover:border-primary/40 hover:shadow-[0_10px_30px_hsl(211_100%_62%/.08)]"
      aria-label={`${ad.title} — ${copy[locale].adVisit}`}
      data-testid="card-advertisement"
    >
      <span className="flex items-center gap-3 px-4 pt-4">
        {ad.logoUrl ? <img src={ad.logoUrl} alt="" className="h-9 w-9 rounded-lg border border-border bg-background object-cover" /> : null}
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[9px] uppercase tracking-[.18em] text-primary">{copy[locale].adLabel}</span>
          <span className="mt-1 block truncate text-sm font-semibold text-foreground">{ad.title}</span>
        </span>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" strokeWidth={1.75} />
      </span>
      <span className="block px-4 pb-3 pt-2 text-xs leading-5 text-muted-foreground">{ad.text}</span>
      {ad.imageUrl ? <img src={ad.imageUrl} alt="" loading="lazy" className="h-20 w-full object-cover" /> : null}
      <span className="flex items-center gap-1.5 px-4 py-3 text-xs font-medium text-primary">{ad.buttonText || copy[locale].adVisit}<ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} /></span>
    </button>
  );
}

function AppError({ onRetry, c }: { onRetry: () => void; c: Copy }) {
  return (
    <div className="mx-auto flex min-h-[65vh] max-w-md flex-col items-center justify-center px-6 text-center animate-slide-up">
      <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-destructive">
        <AlertTriangle className="h-5 w-5" />
      </span>
      <h2 className="font-mono text-base font-medium text-foreground">{c.errorTitle}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{c.errorDetail}</p>
      <Button variant="secondary" className="mt-6" onClick={onRetry} data-testid="button-retry-inbox">
        <RefreshCw className="h-4 w-4" /> {c.retry}
      </Button>
    </div>
  );
}

type MailFailure = { code: string; retryAfterSeconds: number };
function mailFailure(error: unknown): MailFailure {
  const data = (error as { data?: { code?: unknown; retryAfterSeconds?: unknown } })?.data;
  return { code: typeof data?.code === 'string' ? data.code : 'UNKNOWN', retryAfterSeconds: Math.max(1, Number(data?.retryAfterSeconds) || 60) };
}
function AddressErrorCard({ failure, c, onRetry, pending }: { failure: MailFailure; c: Copy; onRetry: () => void; pending: boolean }) {
  const [readyAt, setReadyAt] = useState(() => Date.now() + failure.retryAfterSeconds * 1000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setReadyAt(Date.now() + failure.retryAfterSeconds * 1000); }, [failure.code, failure.retryAfterSeconds]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const wait = Math.max(0, Math.ceil((readyAt - now) / 1000));
  const message = failure.code === 'PROVIDERS_BUSY' ? c.providersBusy : failure.code === 'USER_RATE_LIMIT' ? c.userRateLimit : c.addressUnavailable;
  const supportNeeded = ['PROVIDERS_DOWN', 'DB_ERROR', 'UNKNOWN'].includes(failure.code);
  return <section className="mt-7 rounded-2xl border border-destructive/25 bg-card p-5" data-testid="card-address-error">
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive"><AlertTriangle className="h-5 w-5" /></span><div><p className="text-sm leading-6 text-foreground">{message}</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">{c.errorCode}: {failure.code}</p></div></div>
    <div className="mt-5 flex flex-wrap gap-2"><Button variant="secondary" onClick={onRetry} disabled={wait > 0 || pending}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{c.retry}{wait > 0 ? ` (${wait})` : ''}</Button>{supportNeeded ? <Button variant="ghost" onClick={openSupport}>{c.support}</Button> : null}</div>
  </section>;
}

function LoadingView({ c }: { c: Copy }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-12 pt-8 sm:px-6 sm:pt-12" data-testid="state-loading">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        {c.loading}
      </div>
      <Skeleton className="mt-5 h-[142px] w-full rounded-2xl" />
      <div className="mt-8 flex items-center justify-between">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-[78px] w-full rounded-xl" />
        <Skeleton className="h-[78px] w-full rounded-xl" />
        <Skeleton className="h-[78px] w-full rounded-xl" />
      </div>
    </div>
  );
}

function LanguageSheet({
  locale,
  onSelect,
  onClose,
  pending,
  c,
}: {
  locale: Locale;
  onSelect: (locale: Locale) => void;
  onClose: () => void;
  pending: boolean;
  c: Copy;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="w-full max-w-md rounded-t-2xl border border-border bg-popover p-5 shadow-2xl sm:rounded-2xl animate-slide-up" role="dialog" aria-modal="true" aria-labelledby="language-title">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 id="language-title" className="font-mono text-sm font-medium text-foreground">{c.languageTitle}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{c.languageDetail}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground" data-testid="button-close-language">
            <X className="h-4 w-4" />
            <span className="sr-only">{c.close}</span>
          </button>
        </div>
        <div className="space-y-2">
          {(Object.keys(localeLabels) as Locale[]).map((item) => (
            <button
              type="button"
              key={item}
              onClick={() => onSelect(item)}
              disabled={pending}
              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3.5 text-left transition-colors ${locale === item ? 'border-primary/70 bg-primary/10' : 'border-border bg-secondary/40 hover:bg-secondary'}`}
              data-testid={`button-language-${item}`}
            >
              <span>
                <span className="block text-sm font-medium text-foreground">{localeLabels[item]}</span>
                <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">{item}</span>
              </span>
              {locale === item ? <Check className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ToastMessage({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div className={`fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border px-3.5 py-2.5 text-xs shadow-2xl animate-slide-up ${error ? 'border-destructive/30 bg-[hsl(0_28%_14%)] text-destructive' : 'border-primary/30 bg-[hsl(211_35%_13%)] text-foreground'}`} role="status" data-testid="toast-message">
      {error ? <AlertTriangle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5 text-primary" />}
      {text}
    </div>
  );
}

function RefreshDialog({
  onConfirm,
  onClose,
  pending,
  c,
}: {
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  c: Copy;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/65 p-5" role="presentation">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-popover p-5 shadow-2xl animate-slide-up" role="dialog" aria-modal="true" aria-labelledby="refresh-title">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><RefreshCw className="h-5 w-5" /></div>
        <h2 id="refresh-title" className="mt-5 font-mono text-sm font-medium">{c.refreshAddress}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{c.refreshDetail}</p>
        <div className="mt-6 grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending} data-testid="button-cancel-refresh">{c.cancel}</Button>
          <Button variant="primary" onClick={onConfirm} disabled={pending} data-testid="button-confirm-refresh">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {pending ? c.refreshing : c.confirmRefresh}
          </Button>
        </div>
      </section>
    </div>
  );
}

function MessageDetail({
  messageId,
  locale,
  c,
  onBack,
}: {
  messageId: string;
  locale: Locale;
  c: Copy;
  onBack: () => void;
}) {
  const query = useGetMailMessage(messageId, {
    query: { enabled: Boolean(messageId), queryKey: getGetMailMessageQueryKey(messageId) },
    request: { credentials: 'include', headers: { Authorization: getTelegramAuthorization() } },
  });
  const message = query.data;
  useEffect(() => {
    const telegram = getTelegramWebApp();
    const goBack = () => onBack();
    telegram?.BackButton?.show?.();
    telegram?.BackButton?.onClick?.(goBack);
    return () => {
      telegram?.BackButton?.offClick?.(goBack);
      telegram?.BackButton?.hide?.();
    };
  }, [onBack]);
  return (
    <div className="fixed inset-0 z-20 overflow-y-auto bg-background" data-testid="panel-message-detail">
      <div className="mx-auto min-h-full w-full max-w-3xl px-4 pb-12 sm:px-6">
        <header className="sticky top-0 z-10 -mx-4 flex items-center justify-between border-b border-border bg-background/90 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground" data-testid="button-back-inbox">
            <ArrowLeft className="h-4 w-4" /> {c.back}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">{c.inbox}</span>
        </header>
        {query.isLoading ? (
          <div className="pt-10" data-testid="state-message-loading"><Skeleton className="h-8 w-4/5" /><Skeleton className="mt-4 h-4 w-2/5" /><Skeleton className="mt-10 h-40 w-full rounded-xl" /></div>
        ) : query.isError || !message ? (
          <AppError c={c} onRetry={() => void query.refetch()} />
        ) : (
          <article className="animate-slide-up pt-8" data-testid={`article-message-${message.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[.2em] text-primary">{c.sender}</p>
                <h1 className="mt-3 max-w-2xl font-mono text-xl font-medium leading-8 text-foreground sm:text-2xl">{message.subject || c.subjectFallback}</h1>
              </div>
              <time className="font-mono text-[11px] text-muted-foreground" dateTime={message.receivedAt}>{formatReceived(message.receivedAt, locale, c)}</time>
            </div>
            <div className="mt-7 flex items-center gap-3 border-y border-border py-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 font-mono text-xs text-primary">{message.sender.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{message.sender}</p>
                {message.senderEmail ? <p className="truncate font-mono text-[11px] text-muted-foreground">{message.senderEmail}</p> : null}
              </div>
            </div>
            {message.verificationCode ? (
              <div className="mt-7 rounded-xl border border-primary/25 bg-primary/10 p-4">
                <p className="font-mono text-[10px] uppercase tracking-[.18em] text-primary">{c.verification}</p>
                <p className="mt-2 font-mono text-2xl tracking-[.22em] text-foreground" data-testid="text-verification-code">{message.verificationCode}</p>
              </div>
            ) : null}
            <div
              className="prose prose-invert mt-8 max-w-none text-sm leading-7 text-secondary-foreground"
              data-testid="content-message"
              onClick={(event) => {
                const anchor = (event.target as HTMLElement).closest('a');
                const href = anchor?.getAttribute('href');
                if (href) {
                  event.preventDefault();
                  getTelegramWebApp()?.openLink?.(href) ?? window.open(href, '_blank', 'noopener,noreferrer');
                }
              }}
            >
              {message.html ? <div dangerouslySetInnerHTML={{ __html: message.html }} /> : <p className="whitespace-pre-wrap">{message.text || c.emptyText}</p>}
            </div>
          </article>
        )}
      </div>
    </div>
  );
}

function AddressHeader({
  session,
  countdown,
  c,
  onCopy,
  onRefresh,
  onNewAddress,
  onLanguage,
  copyState,
}: {
  session: MailSession;
  countdown: ReturnType<typeof formatCountdown>;
  c: Copy;
  onCopy: () => void;
  onRefresh: () => void;
  onNewAddress: () => void;
  onLanguage: () => void;
  copyState: boolean;
}) {
  const canRefresh = session.refreshesUsed < session.refreshesLimit;
  return (
    <>
      <section className={`relative overflow-hidden rounded-2xl border p-5 sm:p-6 ${countdown.urgent ? 'border-amber-400/40 bg-[hsl(35_22%_12%)]' : 'border-border bg-card'}`} data-testid="card-mail-session">
        <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">{c.inbox}</p>
              <div className="mt-3 flex max-w-full items-center gap-2">
                <code className="break-all font-mono text-base font-medium text-foreground sm:text-lg" data-testid="text-mail-address">{session.address}</code>
                <button type="button" onClick={onCopy} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-primary" aria-label={c.copy} data-testid="button-copy-address">
                  {copyState ? <Check className="h-4 w-4 text-primary" /> : <Clipboard className="h-4 w-4" />}
                </button>
              </div>
              {copyState ? <p className="mt-2 text-[11px] text-primary" data-testid="text-copy-feedback">{c.copied}</p> : null}
            </div>
            <div className={`shrink-0 text-right ${countdown.urgent ? 'text-amber-300' : 'text-primary'}`}>
              <div className="flex items-center justify-end gap-1.5"><Clock3 className="h-3.5 w-3.5" /><span className="font-mono text-[10px] uppercase tracking-[.14em]">{c.expiresIn}</span></div>
              <p className="mt-1 font-mono text-2xl font-medium tabular-nums" data-testid="text-countdown">{countdown.expired ? '--:--' : countdown.label}</p>
            </div>
          </div>
          {countdown.urgent && !countdown.expired ? <div className="mt-5 flex items-center gap-2 border-t border-amber-400/20 pt-4 text-xs text-amber-200" data-testid="status-countdown-warning"><AlertTriangle className="h-4 w-4" /> {c.expiresSoon}</div> : null}
          {countdown.expired ? <div className="mt-5 flex items-center justify-between gap-3 border-t border-destructive/20 pt-4"><span className="flex items-center gap-2 text-xs text-destructive"><AlertTriangle className="h-4 w-4" /> {c.expired}</span><Button variant="danger" onClick={onNewAddress} data-testid="button-refresh-expired"><Plus className="h-4 w-4" /> {c.create}</Button></div> : null}
        </div>
      </section>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button type="button" onClick={onLanguage} className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground" data-testid="button-open-language">
          <Globe2 className="h-3.5 w-3.5" /> {localeLabels[session.language]}
        </button>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{session.refreshesUsed}/{session.refreshesLimit} {c.refreshes}</span>
          {!countdown.expired ? <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={onRefresh} disabled={!canRefresh} data-testid="button-refresh-address"><RefreshCw className="h-3.5 w-3.5" /> {c.refresh}</Button> : null}
        </div>
      </div>
      <button type="button" onClick={onNewAddress} className="mt-2 inline-flex min-h-12 items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" data-testid="button-new-address">
        <Plus className="h-4 w-4" /> {c.create}
      </button>
    </>
  );
}

function InboxList({
  messages,
  locale,
  c,
  onOpen,
  isFetching,
}: {
  messages: MailMessage[];
  locale: Locale;
  c: Copy;
  onOpen: (id: string) => void;
  isFetching: boolean;
}) {
  return (
    <section className="mt-9" data-testid="section-message-list">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-xs uppercase tracking-[.18em] text-muted-foreground">{c.inbox}</h2>
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" /> : null}
      </div>
      {messages.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-14 text-center" data-testid="state-empty-inbox">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground"><Inbox className="h-5 w-5" /></span>
          <h3 className="mt-5 font-mono text-sm text-foreground">{c.noMessages}</h3>
          <p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-muted-foreground">{c.noMessagesDetail}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map((message, index) => (
            <button type="button" key={message.id} onClick={() => onOpen(message.id)} className={`group flex w-full items-start gap-3 rounded-xl border px-4 py-4 text-left transition-all hover:border-primary/40 hover:bg-card ${message.isRead ? 'border-border bg-card/50' : 'border-primary/20 bg-card'}`} data-testid={`row-message-${message.id}`}>
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] ${message.isRead ? 'bg-secondary text-muted-foreground' : 'bg-primary/15 text-primary'}`}>{message.sender.slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className={`truncate text-sm ${message.isRead ? 'font-medium text-secondary-foreground' : 'font-semibold text-foreground'}`}>{message.sender}</span>
                  <time className="shrink-0 font-mono text-[10px] text-muted-foreground" dateTime={message.receivedAt}>{formatReceived(message.receivedAt, locale, c)}</time>
                </span>
                <span className="mt-1 block truncate text-xs font-medium text-foreground">{message.subject || c.subjectFallback}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{message.preview || message.text || c.emptyText}</span>
              </span>
              <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Home({ isAdmin = false }: { isAdmin?: boolean }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const requestOptions = { credentials: 'include' as const, headers: { Authorization: getTelegramAuthorization() } };
  const sessionQuery = useGetMailSession({ query: { queryKey: getGetMailSessionQueryKey(), retry: false, refetchOnWindowFocus: false }, request: requestOptions });
  const session = sessionQuery.data;
  const [creationFailure, setCreationFailure] = useState<MailFailure | null>(null);
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const createSession = useCreateMailSession({ request: requestOptions });
  const refreshSession = useRefreshMailSession({ request: requestOptions });
  const updateLanguage = useUpdateMailLanguage({ request: requestOptions });
  const inboxQuery = useGetMailInbox({
    query: {
      enabled: Boolean(session && new Date(session.expiresAt).getTime() > Date.now()),
      queryKey: getGetMailInboxQueryKey(),
      refetchInterval: 5000,
      refetchOnWindowFocus: true,
    },
    request: requestOptions,
  });
  const c = copy[locale];
  const countdown = useCountdown(session?.expiresAt);

  useEffect(() => {
    if (session?.language) setLocale(session.language);
  }, [session?.language]);

  useEffect(() => {
    const telegram = getTelegramWebApp();
    if (supportsCloudStorage(telegram)) {
      telegram?.CloudStorage?.getItem?.('jnt-mail-language', (_error, value) => {
        if (value === 'tr' || value === 'ru' || value === 'en') setLocale(value);
      });
    }
  }, []);

  useEffect(() => {
    prepareTelegramWebApp();
  }, []);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
  }, []);

  const messages = useMemo(() => inboxQuery.data?.messages ?? [], [inboxQuery.data?.messages]);
  const unreadCount = inboxQuery.data?.unreadCount ?? messages.filter((message) => !message.isRead).length;

  function showToast(text: string, error = false) {
    setToast({ text, error });
    window.setTimeout(() => setToast(null), 3000);
  }

  function copyAddress() {
    if (!session) return;
    if (!navigator.clipboard) {
      showToast(c.copyError, true);
      return;
    }
    void navigator.clipboard.writeText(session.address).then(() => {
      telegramHaptic('success');
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2200);
    }).catch(() => showToast(c.copyError, true));
  }

  function createAddress() {
    telegramHaptic('light');
    setCreationFailure(null);
    createSession.mutate(undefined, {
      onSuccess: (newSession) => {
        setLocale(newSession.language);
        queryClient.setQueryData(getGetMailSessionQueryKey(), newSession);
        queryClient.setQueryData(getGetMailInboxQueryKey(), { messages: [], unreadCount: 0, checkedAt: new Date().toISOString() });
      },
      onError: (caught) => setCreationFailure(mailFailure(caught)),
    });
  }

  function refreshAddress() {
    telegramHaptic('light');
    refreshSession.mutate(undefined, {
      onSuccess: (newSession) => {
        setRefreshOpen(false);
        queryClient.setQueryData(getGetMailSessionQueryKey(), newSession);
        queryClient.setQueryData(getGetMailInboxQueryKey(), { messages: [], unreadCount: 0, checkedAt: new Date().toISOString() });
        showToast(c.newAddress);
      },
      onError: () => showToast(c.sessionError, true),
    });
  }

  function openAdminPanel() {
    telegramHaptic('light');
    navigate('/admin');
  }

  function selectLanguage(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem('jnt-mail-language', nextLocale);
    const telegram = getTelegramWebApp();
    if (supportsCloudStorage(telegram)) telegram?.CloudStorage?.setItem?.('jnt-mail-language', nextLocale);
    updateLanguage.mutate({ data: { language: nextLocale } }, {
      onSuccess: (updatedSession) => {
        queryClient.setQueryData(getGetMailSessionQueryKey(), updatedSession);
        setLanguageOpen(false);
      },
      onError: () => showToast(c.sessionError, true),
    });
  }

  const noSession = !session && !sessionQuery.isLoading && !sessionQuery.isError;
  const activeFailure = creationFailure ?? (sessionQuery.isError ? mailFailure(sessionQuery.error) : null);
  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-background">
      <div className="app-grid pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-50" />
      <header className="relative border-b border-border/80">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div>
              <p className="brand-lockup font-mono text-base font-semibold tracking-[.1em] text-foreground"><span>JNT</span> <span className="text-primary underline decoration-primary/60 underline-offset-4">MAIL</span></p>
              <p className="hidden font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground sm:block">{copy[locale].privateUtility}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`${isAdmin ? 'hidden min-[420px]:inline-flex' : 'inline-flex'} items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/5 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[.1em] text-emerald-300`}><span className="live-dot" /> {copy[locale].live}</span>
            {isAdmin ? (
              <button type="button" onClick={openAdminPanel} className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[.1em] text-primary transition-colors hover:bg-primary/15" data-testid="button-open-admin">
                <ShieldCheck className="h-3.5 w-3.5" /> {c.admin}
              </button>
            ) : null}
            <button type="button" onClick={() => setLanguageOpen(true)} className="flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground transition-colors hover:text-foreground" data-testid="button-header-language">
              <Globe2 className="h-3.5 w-3.5" /> {locale.toUpperCase()}
            </button>
          </div>
        </div>
      </header>
      <main className="relative mx-auto w-full max-w-3xl px-4 pb-16 sm:px-6">
        <AdvertisementCard locale={locale} />
        {sessionQuery.isLoading ? <LoadingView c={c} /> : activeFailure && !session ? <AddressErrorCard failure={activeFailure} c={c} pending={sessionQuery.isFetching || createSession.isPending} onRetry={() => { setCreationFailure(null); void sessionQuery.refetch(); }} /> : noSession ? (
          <div className="mx-auto flex min-h-[72vh] max-w-md flex-col items-center justify-center text-center animate-slide-up">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary"><ShieldCheck className="h-6 w-6" /></span>
            <h1 className="mt-7 font-mono text-xl font-medium text-foreground">{c.loading}</h1>
            <p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">{c.noMessagesDetail}</p>
            <Button variant="primary" className="mt-7" onClick={createAddress} disabled={createSession.isPending} data-testid="button-create-address">
              {createSession.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {createSession.isPending ? c.newAddress : c.create}
            </Button>
          </div>
        ) : session ? (
          <div className="pt-7 sm:pt-10">
             <AddressHeader session={session} countdown={countdown} c={c} onCopy={copyAddress} onRefresh={() => setRefreshOpen(true)} onNewAddress={createAddress} onLanguage={() => setLanguageOpen(true)} copyState={copied} />
            {creationFailure ? <AddressErrorCard failure={creationFailure} c={c} pending={createSession.isPending} onRetry={createAddress} /> : null}
            {inboxQuery.isError ? <p className="mt-7 text-xs text-muted-foreground" role="status">{c.inboxRefreshFailed}</p> : null}
            <InboxList messages={messages} locale={locale} c={c} onOpen={setSelectedMessageId} isFetching={inboxQuery.isFetching} />
            <div className="mt-8 flex items-center justify-between border-t border-border pt-4 text-[10px] text-muted-foreground">
              <span>{unreadCount} {c.unread}</span>
              <span className="font-mono">{inboxQuery.data?.checkedAt ? `${c.checked} ${formatReceived(inboxQuery.data.checkedAt, locale, c)}` : c.checking}</span>
            </div>
            <a href="https://mail.tm" onClick={(event) => { event.preventDefault(); const app = getTelegramWebApp(); if (app?.openLink) app.openLink('https://mail.tm'); else window.open('https://mail.tm', '_blank', 'noopener,noreferrer'); }} className="mt-3 inline-block font-mono text-[9px] text-muted-foreground hover:text-primary">Powered by mail.tm</a>
          </div>
        ) : null}
      </main>
      <JaiPanel locale={locale} c={c} authorization={getTelegramAuthorization()} sessionActive={Boolean(session && !countdown.expired)} secondsLeft={countdown.seconds} refreshesUsed={session?.refreshesUsed ?? 0} lastErrorCode={activeFailure?.code} />
      {selectedMessageId ? <MessageDetail messageId={selectedMessageId} locale={locale} c={c} onBack={() => { setSelectedMessageId(null); void queryClient.invalidateQueries({ queryKey: getGetMailMessageQueryKey(selectedMessageId) }); }} /> : null}
      {languageOpen ? <LanguageSheet locale={locale} onSelect={selectLanguage} onClose={() => setLanguageOpen(false)} pending={updateLanguage.isPending} c={c} /> : null}
      {refreshOpen ? <RefreshDialog onConfirm={refreshAddress} onClose={() => setRefreshOpen(false)} pending={refreshSession.isPending} c={c} /> : null}
      {toast ? <ToastMessage text={toast.text} error={toast.error} /> : null}
    </div>
  );
}

function AdminRoute() {
  return (
    <Suspense fallback={<main className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">JNT Mail yönetim paneli yükleniyor</main>}>
      <LazyAdminApp />
    </Suspense>
  );
}

function Router() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/admin" component={AdminRoute} />
        <Route path="/" component={GateProtectedHome} />
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;