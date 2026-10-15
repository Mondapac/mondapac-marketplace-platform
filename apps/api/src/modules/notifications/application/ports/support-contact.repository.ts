import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One stored version of the support address. */
export interface SupportContactRecord {
  readonly version: number;
  readonly email: string;
  readonly changedAt: Temporal.Instant;
}

/**
 * The support address history of one Market (`notifications.support_contacts`, insert-only).
 * Every method runs inside the caller's unit of work and is scoped by the Market.
 */
export interface SupportContactRepository {
  /** The newest version, or null before the first admin change. */
  latest(market: MarketContext): Promise<SupportContactRecord | null>;

  /** Appends the next version; false when that version already exists (a concurrent change). */
  append(
    market: MarketContext,
    record: SupportContactRecord & {
      readonly previousEmail: string | null;
      readonly changedBy: Id<'Account'>;
    },
  ): Promise<boolean>;
}

export const SUPPORT_CONTACT_REPOSITORY = Symbol('SUPPORT_CONTACT_REPOSITORY');
