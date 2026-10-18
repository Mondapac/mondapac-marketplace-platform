import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ConsentSource, MarketingChannel } from '../../domain/marketing-consent';

/** The current consent of one account on one channel. */
export interface MarketingConsentRecord {
  readonly id: Id<'MarketingConsent'>;
  readonly accountId: Id<'Account'>;
  readonly channel: MarketingChannel;
  readonly granted: boolean;
  readonly source: ConsentSource;
  readonly changedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
}

/** One change, appended to the history and never changed. */
export interface MarketingConsentChange {
  readonly id: Id<'MarketingConsentChange'>;
  readonly accountId: Id<'Account'>;
  readonly channel: MarketingChannel;
  readonly granted: boolean;
  readonly source: ConsentSource;
  readonly occurredAt: Temporal.Instant;
}

/**
 * `legal.marketing_consents` and its history `legal.marketing_consent_changes`. Every read and
 * write is scoped by the Market and the account; runs inside the caller's unit of work.
 */
export interface MarketingConsentRepository {
  find(
    market: MarketContext,
    accountId: Id<'Account'>,
    channel: MarketingChannel,
  ): Promise<MarketingConsentRecord | null>;

  /** Writes the current consent (insert or change) and appends the change, in one unit. */
  record(
    market: MarketContext,
    current: MarketingConsentRecord,
    change: MarketingConsentChange,
  ): Promise<void>;
}

export const MARKETING_CONSENT_REPOSITORY = Symbol('MARKETING_CONSENT_REPOSITORY');
