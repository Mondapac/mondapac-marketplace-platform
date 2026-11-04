import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { SellerHealthSignals } from '../application/ports/seller-health-signals';
import type { SellerHealthDay } from '../domain/seller-health-days';

/**
 * The health feeds as `SellersModule` provides them. Sellers cannot import ordering, reviews or
 * commission-payouts (each imports sellers), so `SellerHealthModule` binds the real feeds at
 * start. Until then a read throws, so a run stores nothing (fail closed).
 */
export class LateBoundSellerHealthSignals implements SellerHealthSignals {
  #bound: SellerHealthSignals | null = null;

  /** Binds the real feeds once; a second bind is a wiring fault and throws. */
  bind(signals: SellerHealthSignals): void {
    if (this.#bound !== null) throw new Error('LateBoundSellerHealthSignals is already bound');
    this.#bound = signals;
  }

  days(
    context: CallContext,
    sellerId: Id<'Seller'>,
    days: readonly Temporal.PlainDate[],
    zone: string,
  ): Promise<readonly SellerHealthDay[]> {
    if (this.#bound === null) {
      return Promise.reject(new Error('seller-health.signals: the feeds are not bound'));
    }
    return this.#bound.days(context, sellerId, days, zone);
  }
}
