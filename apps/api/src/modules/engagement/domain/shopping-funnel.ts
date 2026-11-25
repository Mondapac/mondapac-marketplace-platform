import type { Id } from '@mondapac/shared-kernel';

// The shopping funnel of one Market day (dashboards v2, phase 2). Counted from ONE population:
// signed-in customers who have not switched personalization off. Behaviour is recorded for an
// account only while its switch is on, and switching it off deletes the account's events in the
// same unit (under the account lock), so every account with an event of the day is in the
// population. Guests are never counted. Each step is a count of distinct accounts that did that
// step AND every step before it on the day, so the steps only go down and their rates compare.
// Only counts leave this module; no account id does.

/** The most accounts with a `product-viewed` (or an `added-to-cart`) event one day may have. */
export const MAX_FUNNEL_ACCOUNTS = 100_000;
/** The most accounts that started a checkout one funnel request may name. */
export const MAX_FUNNEL_CHECKOUTS = 5_000;
/** The longest window one funnel request may cover: a Market day of 25 hours, with a margin. */
export const MAX_FUNNEL_WINDOW_HOURS = 26;

/** An account that placed an order in the window, and whether one of those orders was paid. */
export interface FunnelCheckout {
  readonly accountId: Id<'Account'>;
  readonly paid: boolean;
}

/** The four steps of the funnel, each a count of distinct accounts. */
export interface ShoppingFunnelCounts {
  /** Viewed a product. */
  readonly viewed: number;
  /** Viewed a product and added to the cart. */
  readonly carted: number;
  /** ... and placed an order (started checkout). */
  readonly checkedOut: number;
  /** ... and paid for one of those orders. */
  readonly paid: number;
}

/**
 * The nested counts of a day: `viewed` the accounts with a `product-viewed` event, `carted` those
 * of them with an `added-to-cart` event, `checkedOut` those of them that placed an order, `paid`
 * those of them with a paid order. A checkout listed twice counts once (paid if either is).
 */
export function shoppingFunnelOf(
  viewers: ReadonlySet<Id<'Account'>>,
  carters: ReadonlySet<Id<'Account'>>,
  checkouts: readonly FunnelCheckout[],
): ShoppingFunnelCounts {
  const carted = new Set([...carters].filter((account) => viewers.has(account)));
  const placed = new Map<Id<'Account'>, boolean>();
  for (const checkout of checkouts) {
    if (!carted.has(checkout.accountId)) continue;
    placed.set(checkout.accountId, (placed.get(checkout.accountId) ?? false) || checkout.paid);
  }
  let paid = 0;
  for (const isPaid of placed.values()) if (isPaid) paid += 1;
  return { viewed: viewers.size, carted: carted.size, checkedOut: placed.size, paid };
}
