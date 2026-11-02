import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { SellerHealthDay } from '../../domain/seller-health-days';

/**
 * Where the counters of one local day come from: the facades of ordering (paid and ready orders,
 * late against the frozen promise), reviews (approved reviews) and payments or commission-payouts
 * (disputes the seller lost). The reader counts the seller's own faults only and recounts the
 * whole day each time. `zone` is the seller's IANA zone: it decides where the day starts and
 * ends (ADR-0005). A failed read throws; the rollup then stores nothing for the day.
 */
export interface SellerHealthSignals {
  day(
    context: CallContext,
    sellerId: Id<'Seller'>,
    day: Temporal.PlainDate,
    zone: string,
  ): Promise<SellerHealthDay>;
}

export const SELLER_HEALTH_SIGNALS = Symbol('SELLER_HEALTH_SIGNALS');
