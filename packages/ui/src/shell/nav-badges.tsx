'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** A count beside a menu item, as its source reported it. */
export interface NavBadgeValue {
  readonly count: number;
  /** `critical` when something needs attention at once (overdue); otherwise `info`. */
  readonly tone: 'info' | 'critical';
  /** The words a screen reader adds after the item's name ("3 waiting for you, 1 overdue"). */
  readonly label: string;
}

/** The largest count the badge writes out; a larger one reads "99+". */
export const NAV_BADGE_CAP = 99;

interface NavBadgeContext {
  readonly badges: Readonly<Record<string, NavBadgeValue>>;
  readonly setBadge: (source: string, value: NavBadgeValue | null) => void;
}

const NONE: NavBadgeContext = { badges: {}, setBadge: () => undefined };
const Context = createContext<NavBadgeContext>(NONE);

/**
 * Holds the menu badges by `NavItem.badgeSource`. The app fetches each count (with a component
 * that calls `useSetNavBadge`); the sidebar only draws what is here. A source with no value, or a
 * count of 0, shows nothing, so a failed fetch never shows an error in the menu.
 */
export function NavBadgeProvider({ children }: { readonly children: ReactNode }) {
  const [badges, setBadges] = useState<Readonly<Record<string, NavBadgeValue>>>({});
  const setBadge = useCallback((source: string, value: NavBadgeValue | null) => {
    setBadges((current) => {
      const { [source]: previous, ...rest } = current;
      if (value === null) return previous === undefined ? current : rest;
      if (
        previous?.count === value.count &&
        previous.tone === value.tone &&
        previous.label === value.label
      ) {
        return current;
      }
      return { ...rest, [source]: value };
    });
  }, []);
  const value = useMemo(() => ({ badges, setBadge }), [badges, setBadge]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useNavBadges = () => useContext(Context).badges;
export const useSetNavBadge = () => useContext(Context).setBadge;

/** The text of a count: the number, or "99+" above the cap. */
export const badgeText = (count: number): string =>
  count > NAV_BADGE_CAP ? `${NAV_BADGE_CAP}+` : String(count);

const TONE = {
  info: 'bg-info-bg text-info-fg',
  critical: 'bg-critical-bg text-critical-fg',
} as const;

/** The pill itself (hidden from screen readers: the item carries the words). */
export function NavBadgePill({
  count,
  tone,
}: {
  readonly count: number;
  readonly tone: NavBadgeValue['tone'];
}) {
  return (
    <span
      aria-hidden="true"
      data-nav-badge=""
      className={`ms-auto inline-flex min-w-6 shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums group-data-[rail=true]/rail:hidden ${TONE[tone]}`}
    >
      {badgeText(count)}
    </span>
  );
}

/** What the badges of some sources add up to: one pill for a closed group, and its spoken words. */
export function sumBadges(
  sources: readonly (string | undefined)[],
  badges: Readonly<Record<string, NavBadgeValue>>,
): NavBadgeValue | null {
  const found = sources.flatMap((source) => {
    const value = source === undefined ? undefined : badges[source];
    return value === undefined || value.count <= 0 ? [] : [value];
  });
  if (found.length === 0) return null;
  return {
    count: found.reduce((sum, value) => sum + value.count, 0),
    tone: found.some((value) => value.tone === 'critical') ? 'critical' : 'info',
    label: found.map((value) => value.label).join('; '),
  };
}
