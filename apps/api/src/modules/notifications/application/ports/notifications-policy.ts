import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings notifications reads. */
export interface NotificationsPolicy {
  /** The support address from Market configuration; null when the Market has none. */
  defaultSupportEmail(market: MarketContext): string | null;
}

export const NOTIFICATIONS_POLICY = Symbol('NOTIFICATIONS_POLICY');
