import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  overrideInBounds,
  resolvePayoutTerms,
  type PayoutTerms,
  type TermsUnavailable,
} from '../domain/payout-terms';
import type { PayoutTermsPolicy } from './ports/payout-terms-policy';
import type {
  PayoutTermsOverrideRecord,
  PayoutTermsRepository,
} from './ports/payout-terms.repository';

/** The terms in force for one seller, and where they come from. */
export interface EffectivePayoutTerms {
  readonly terms: PayoutTerms;
  /** `seller` when the seller has an override row, else `market`. */
  readonly source: 'seller' | 'market';
  /** The override row as stored, or null. */
  readonly override: PayoutTermsOverrideRecord | null;
}

/**
 * The effective payout terms of a seller (package 6b): the Market's values from Market config with
 * the seller's override over them. Fail closed: no Market terms, or an override (or a result)
 * outside the bounds, answers `terms-unavailable`, and callers anchor and pay nothing on it. It
 * reads the override through the caller's open unit of work.
 */
export class PayoutTermsResolver {
  constructor(
    private readonly policy: PayoutTermsPolicy,
    private readonly overrides: PayoutTermsRepository,
  ) {}

  async resolve(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<EffectivePayoutTerms, TermsUnavailable>> {
    const override = await this.overrides.find(market, sellerId);
    if (override !== null && !overrideInBounds(override.override)) {
      return err({ code: 'commission-payouts.terms-unavailable' });
    }
    const terms = resolvePayoutTerms(this.policy.marketTerms(market), override?.override ?? null);
    if (!terms.ok) return terms;
    return ok({ terms: terms.value, source: override === null ? 'market' : 'seller', override });
  }
}

export const PAYOUT_TERMS_RESOLVER = Symbol('PAYOUT_TERMS_RESOLVER');
