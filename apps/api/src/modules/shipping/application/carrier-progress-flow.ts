import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { MAX_CARRIER_PROGRESS_IDS } from '../contracts/shipping.facade';
import { carrierProgressView, type CarrierProgressView } from '../domain/carrier-progress';
import type { ShippingDependencies } from './shipping-dependencies';

export type CarrierProgressFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed' }
  | { readonly code: 'shipping.unavailable' };

/**
 * `carrier-progress-of`: the carrier progress of some seller orders, for an admin list. The ids
 * are checked and deduplicated, then capped; the bookings are read in ONE query in a read-only
 * unit, and only the asked ids are answered. The key check is the use case's rule.
 */
export async function readCarrierProgress(
  deps: Pick<ShippingDependencies, 'unitOfWork' | 'bookings'>,
  context: CallContext,
  input: { readonly sellerOrderIds: unknown },
): Promise<Result<ReadonlyMap<Id<'SellerOrder'>, CarrierProgressView>, CarrierProgressFailure>> {
  const raw = input?.sellerOrderIds;
  if (!Array.isArray(raw)) return err({ code: 'validation.failed' });
  const asked = new Set<Id<'SellerOrder'>>();
  for (const value of raw as unknown[]) {
    const parsed = typeof value === 'string' ? parseId<'SellerOrder'>(value) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
    asked.add(parsed.value);
  }
  if (asked.size > MAX_CARRIER_PROGRESS_IDS) return err({ code: 'validation.failed' });
  if (asked.size === 0) return ok(new Map());
  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.bookings.progressOfSellerOrders(market, [...asked])),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'shipping.unavailable' });
  const answer = new Map<Id<'SellerOrder'>, CarrierProgressView>();
  for (const record of read.value) {
    if (asked.has(record.sellerOrderId)) {
      answer.set(record.sellerOrderId, carrierProgressView(record));
    }
  }
  return ok(answer);
}
