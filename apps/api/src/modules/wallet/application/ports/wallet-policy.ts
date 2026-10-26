import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market's wallet settings (Market config `wallet`). */
export interface WalletSettings {
  readonly currency: string;
  readonly timeZone: string;
  /** The most one customer wallet may hold (available plus held), in minor units. */
  readonly balanceCapMinor: bigint;
  /** Promo credit expires this many calendar months after the grant. */
  readonly promoExpiryMonths: number;
  /** Package 2 (admin issuance): the most one admin grant may be, in minor units. */
  readonly adminIssueCapMinor: bigint;
  /** Package 2: the most one admin may issue per day without a second approval. */
  readonly adminDailyCapMinor: bigint;
  /** Promo lots expiring within this many days are shown as "expiring soon". */
  readonly expiringSoonDays: number;
}

export interface WalletPolicy {
  /** Null when the Market has no wallet settings: the wallet is unavailable (fail closed). */
  settings(market: MarketContext): WalletSettings | null;
}

export const WALLET_POLICY = Symbol('WALLET_POLICY');
