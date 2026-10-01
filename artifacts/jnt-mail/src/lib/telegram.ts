import { useEffect, useRef } from 'react';

export type TelegramWebApp = {
  version?: string;
  isVersionAtLeast?: (version: string) => boolean;
  initData?: string;
  initDataUnsafe?: { user?: { language_code?: string } };
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  HapticFeedback?: { impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void; notificationOccurred?: (type: 'error' | 'success' | 'warning') => void };
  BackButton?: { show?: () => void; hide?: () => void; onClick?: (callback: () => void) => void; offClick?: (callback: () => void) => void };
  CloudStorage?: {
    getItem?: (key: string, callback?: (error: Error | null, value: string) => void) => void;
    setItem?: (key: string, value: string, callback?: (error: Error | null, stored: boolean) => void) => void;
  };
};

export function getTelegramWebApp(): TelegramWebApp | undefined {
  return (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

/** Signed launch data. It is empty when the page is not opened inside Telegram. */
export function getTelegramInitData(): string {
  return getTelegramWebApp()?.initData ?? '';
}

/** Tells Telegram the Mini App is ready, makes it full height and matches the app colors. */
export function prepareTelegramWebApp() {
  const telegram = getTelegramWebApp();
  telegram?.ready?.();
  telegram?.expand?.();
  telegram?.setHeaderColor?.('#0B0D12');
  telegram?.setBackgroundColor?.('#0B0D12');
}

/** Shows Telegram's native back button while the calling component is mounted. */
export function useTelegramBackButton(onBack: () => void) {
  const handler = useRef(onBack);
  useEffect(() => {
    handler.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const telegram = getTelegramWebApp();
    const backButton = telegram?.BackButton;
    if (!backButton?.onClick || !(telegram?.isVersionAtLeast?.('6.1') ?? true)) return;
    const listener = () => handler.current();
    backButton.onClick(listener);
    backButton.show?.();
    return () => {
      backButton.offClick?.(listener);
      backButton.hide?.();
    };
  }, []);
}
