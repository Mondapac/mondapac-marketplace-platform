'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import type { IconName } from '../icons/icon-paths.tsx';
import { useStore } from '../shell/store-context.tsx';

/** The account pages, in menu order (the rail and the phone and tablet account panel). */
export const ACCOUNT_NAV: readonly {
  readonly key: 'overview' | 'orders' | 'addresses' | 'lists' | 'settings';
  readonly href: string;
  readonly icon: IconName;
}[] = [
  { key: 'overview', href: '/account', icon: 'dash' },
  { key: 'orders', href: '/account/orders', icon: 'receipt' },
  { key: 'addresses', href: '/account/addresses', icon: 'pin' },
  { key: 'lists', href: '/account/lists', icon: 'heart' },
  { key: 'settings', href: '/account/settings', icon: 'gear' },
];

/** The menu entry of the current page; an order's details belong to Orders. */
export function useAccountCurrent(): string | undefined {
  const path = usePathname();
  if (path.startsWith('/account/orders')) return '/account/orders';
  return ACCOUNT_NAV.find((n) => n.href === path)?.href;
}

/**
 * Log out: the session ends (live: the API sign-out) and the log-in page shows (the account
 * overview signed out).
 */
export function useLogOut(): () => void {
  const router = useRouter();
  const { signOut, setAccountOpen } = useStore();
  return useCallback(() => {
    setAccountOpen(false);
    void signOut().then(() => router.push('/account'));
  }, [router, signOut, setAccountOpen]);
}
