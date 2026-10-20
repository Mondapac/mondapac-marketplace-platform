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
 * Log out: the sample session ends and the log-in page shows (the account overview signed out).
 * Wired to the customer sign-out when sessions are.
 */
export function useLogOut(): () => void {
  const router = useRouter();
  const { setCustomer, setAccountOpen } = useStore();
  return useCallback(() => {
    setAccountOpen(false);
    setCustomer(null);
    router.push('/account');
  }, [router, setCustomer, setAccountOpen]);
}
