import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import { fulfilmentStrategyFor, REAL_TIME_DELIVERY } from '../domain/real-time-delivery';
import type { CarrierQuoteStop } from './ports/carrier-gateway';
import { readFlatFees, sellerIdsOf, type FlatFeesFailure } from './flat-fee-flow';
import type { ShippingDependencies } from './shipping-dependencies';

// The shipping fee a customer pays at checkout (SHP-02/03, owner decision 2026-10-24): the live
// quote of the real-time carrier for a seller order it will carry, otherwise the seller's flat
// fee. A quote that fails, times out, comes in another currency or falls outside the Market's
// quote bounds falls back to the flat fee, so the carrier being down or wrong never stops a
// checkout or charges a nonsense price. The carrier is called outside every unit.

const logger = new Logger('ShippingFeeFlow');

/** A postcode as a person types it, as the delivery-area check takes it. */
const POSTCODE = /^[\x20-\x7e]{1,16}$/u;

/**
 * At most this many quotes per checkout: beyond it the remaining sellers keep their flat fee, so
 * one cart never fans out into an unbounded number of carrier calls.
 */
export const MAX_QUOTES_PER_CHECKOUT = 10;

export type ShippingFeesFailure = FlatFeesFailure;

/** The fee per seller, and which of them are the carrier's quote (a tax-inclusive price). */
export interface ShippingFeesAnswer {
  readonly fees: ReadonlyMap<Id<'Seller'>, Money>;
  readonly quoted: ReadonlySet<Id<'Seller'>>;
}

/**
 * The drop-off as a quote takes it: the postcode only. The street address, name and phone go to
 * the carrier only once the order is paid; a suburb the customer typed is never used, so the
 * quoted place cannot be moved closer to the seller (Hassan, SHP-02/03).
 */
function quoteDropoffOf(value: unknown): CarrierQuoteStop | null {
  if (typeof value !== 'object' || value === null) return null;
  const { postcode } = value as { postcode?: unknown };
  const code = typeof postcode === 'string' ? postcode.trim() : '';
  return POSTCODE.test(code) ? { postcode: code } : null;
}

/**
 * `shipping-fees`: per requested seller, the fee to charge. First the flat fees (one read-only
 * unit); then, when the Market's carrier is on and serves the drop-off, one quote per seller
 * whose approved pickup postcode it also serves (`real_time_delivery`). A seller with neither a
 * quote nor a flat fee is absent from the map, and ordering refuses it as before (fail closed).
 */
export async function readShippingFees(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerIds: unknown; readonly dropoff: unknown },
): Promise<Result<ShippingFeesAnswer, ShippingFeesFailure>> {
  const dropoff = quoteDropoffOf(input?.dropoff);
  if (dropoff === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'dropoff', code: 'format' }] });
  }
  const parsed = sellerIdsOf(input?.sellerIds);
  if (!parsed.ok) return parsed;
  const sellerIds = parsed.value;
  const read = await readFlatFees(deps, context, { sellerIds });
  if (!read.ok) return read;
  const flat = ok<ShippingFeesAnswer>({ fees: read.value, quoted: new Set() });

  const { market } = context;
  const settings = deps.carrierPolicy.realTimeCarrier(market);
  const dropoffArea = deps.carrierPolicy.serviceAreaOf(market, dropoff.postcode);
  if (settings === null || dropoffArea === null || !settings.serviceAreas.includes(dropoffArea)) {
    return flat;
  }
  const postcodes = await deps.pickups.postcodesOf(context, sellerIds);
  if (!postcodes.ok) {
    log(context, { outcome: 'flat', reason: 'pickup-unavailable' });
    return flat;
  }
  const quoted = sellerIds
    .filter((sellerId) => {
      const postcode = postcodes.value.get(sellerId);
      if (postcode === undefined) return false;
      const pickupArea = deps.carrierPolicy.serviceAreaOf(market, postcode);
      return fulfilmentStrategyFor(settings, pickupArea, dropoffArea) === REAL_TIME_DELIVERY;
    })
    .slice(0, MAX_QUOTES_PER_CHECKOUT);
  if (quoted.length === 0) return flat;

  const currency = deps.policy.currency(market);
  const { minMinor, maxMinor } = settings.quoteBounds;
  const fees = new Map(read.value);
  const taken = new Set<Id<'Seller'>>();
  await Promise.all(
    quoted.map(async (sellerId) => {
      const postcode = postcodes.value.get(sellerId)!;
      const quote = await deps.carrier.quote(market, {
        pickup: { postcode },
        dropoff,
        parcel: settings.parcel,
        mode: settings.mode,
      });
      if (!quote.ok) {
        log(context, { outcome: 'flat', reason: quote.error.code, sellerId });
        return;
      }
      if (quote.value.currency !== currency) {
        log(context, { outcome: 'flat', reason: 'quote-currency', sellerId });
        return;
      }
      if (quote.value.amount < BigInt(minMinor) || quote.value.amount > BigInt(maxMinor)) {
        // A carrier fault or a misconfiguration, never a price to charge: an operator looks.
        logger.warn({
          msg: 'shipping.shipping-fees-quote-out-of-bounds',
          sellerId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return;
      }
      fees.set(sellerId, quote.value);
      taken.add(sellerId);
    }),
  );
  log(context, { outcome: 'quoted', quoted: quoted.length, taken: taken.size });
  return ok({ fees, quoted: taken });
}

function log(context: CallContext, fields: Record<string, unknown>): void {
  logger.log({
    msg: 'shipping.shipping-fees',
    ...fields,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}
