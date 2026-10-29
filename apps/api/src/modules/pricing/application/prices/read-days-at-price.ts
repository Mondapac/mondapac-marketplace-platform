import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_PRICE_HISTORY_WINDOW_DAYS,
  type PricingValidationFailed,
} from '../../contracts/pricing.facade';
import { daysAtPrice } from '../../domain/price-history';
import type { PriceSeriesRepository } from '../ports/price-series.repository';

export interface DaysAtPriceInput {
  readonly key: { readonly offerId: string; readonly variantId: string };
  readonly price: { readonly amount: bigint; readonly currency: string };
  readonly windowDays: number;
}

export interface DaysAtPriceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  readonly clock: Clock;
}

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Reads, in one read-only unit, how many whole days of the last `windowDays` days (ending now)
 * the effective price of one (Offer, Variant) was exactly `price` (the was-price fact). Shared by
 * the pair below. Null when the key has no series in the context's Market (another Market's key
 * is not found, the same answer). Only prices that were in force count: no Cost, no hold, no
 * pending or rejected record (ADR-0024).
 */
export async function readDaysAtPrice(
  deps: DaysAtPriceDependencies,
  context: CallContext,
  input: DaysAtPriceInput,
): Promise<Result<number | null, PricingValidationFailed>> {
  const raw = input as Partial<DaysAtPriceInput> | null;
  const offerId = typeof raw?.key?.offerId === 'string' ? parseId<'Offer'>(raw.key.offerId) : null;
  const variantId =
    typeof raw?.key?.variantId === 'string' ? parseId<'Variant'>(raw.key.variantId) : null;
  if (offerId === null || !offerId.ok || variantId === null || !variantId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'key', code: 'format' }] });
  }
  const price = raw?.price;
  if (
    typeof price?.amount !== 'bigint' ||
    price.amount < 1n ||
    typeof price.currency !== 'string' ||
    !CURRENCY.test(price.currency)
  ) {
    return err({ code: 'validation.failed', fields: [{ path: 'price', code: 'value' }] });
  }
  const windowDays = raw?.windowDays;
  if (
    typeof windowDays !== 'number' ||
    !Number.isInteger(windowDays) ||
    windowDays < 1 ||
    windowDays > MAX_PRICE_HISTORY_WINDOW_DAYS
  ) {
    return err({ code: 'validation.failed', fields: [{ path: 'windowDays', code: 'range' }] });
  }
  const key = { offerId: offerId.value, variantId: variantId.value };
  const asked = { amount: price.amount, currency: price.currency };
  const now = deps.clock.now();
  const from = now.subtract({ hours: windowDays * 24 });
  return deps.unitOfWork.run<number | null, PricingValidationFailed>(
    context.market,
    async () => {
      const series = await deps.series.findByKey(context.market, key);
      if (series === null) return ok(null);
      return ok(daysAtPrice(series.state, asked, from, now));
    },
    { readOnly: true },
  );
}
