import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { SellerDeliveryQuotes } from '../../shipping';
import { planOrder } from '../domain/order';
import { readShipTo, type OrderingDependencies, type StartCheckoutFailure } from './checkout-flow';

// The delivery options of the signed-in buyer's basket (delivery models, package 5): per seller,
// the four methods open or not (with the reason), the price of each delivering method (the
// fleet's quote plus the Market's margin, GST inclusive with the GST shown apart) and the
// scheduled-window facts. The quotes are asked and stored by `shipping`; checkout charges the
// stored quote, so the client never sends a price. Only the saved address's postcode, suburb and
// region go to a fleet (SHP-02/03).

/** Shipping asks at most this many sellers per call (see `shipping.quoteDeliveries`). */
const SELLERS_PER_CALL = 10;

export interface DeliveryQuotesInput {
  readonly addressId: unknown;
}

/** The delivery price with its tax: `total` includes `tax`. */
export interface TaxedDeliveryPrice {
  readonly quoteId: string;
  readonly total: Money;
  readonly tax: Money;
  readonly taxRateBps: number;
  readonly etaMinutes: number | null;
  readonly validUntil: string;
}

export type MethodPrice =
  | { readonly state: 'quoted'; readonly price: TaxedDeliveryPrice }
  | { readonly state: 'no-fleet' }
  | { readonly state: 'failed' };

export interface SellerDeliveryOptions {
  readonly sellerId: Id<'Seller'>;
  readonly availability: SellerDeliveryQuotes['availability'];
  /** The postcode where an in-person pickup is collected; null when the seller offers none. */
  readonly pickupPostcode: string | null;
  readonly prices: Readonly<Partial<Record<'instant' | 'same_day' | 'scheduled', MethodPrice>>>;
}

export type DeliveryQuotesFailure = StartCheckoutFailure;

export async function deliveryQuotes(
  deps: OrderingDependencies,
  context: CallContext,
  input: DeliveryQuotesInput,
): Promise<Result<readonly SellerDeliveryOptions[], DeliveryQuotesFailure>> {
  const address = await readShipTo(deps, context, input?.addressId);
  if (!address.ok) return address;
  const read = await deps.cart.checkoutLines(context);
  if (!read.ok) {
    if (read.error.code === 'cart.not-ready') {
      return err({ code: 'ordering.cart-not-ready', sellers: read.error.details.sellers });
    }
    return err(
      read.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'ordering.check-unavailable' },
    );
  }
  const planned = planOrder(read.value, { maxLines: deps.policy.maxLines() });
  if (!planned.ok) return err(planned.error);
  const dropoff = {
    postcode: address.value.postcode,
    locality: address.value.suburb,
    region: address.value.region,
  };
  const asked = planned.plan.sellers.map((seller) => ({
    sellerId: seller.sellerId,
    itemCount: seller.lines.reduce((count, line) => count + line.quantity, 0),
    declaredValueMinor: Number(seller.subtotal),
  }));
  const quotes = new Map<Id<'Seller'>, SellerDeliveryQuotes>();
  for (let from = 0; from < asked.length; from += SELLERS_PER_CALL) {
    const answer = await deps.shipping.quoteDeliveries(context, {
      sellers: asked.slice(from, from + SELLERS_PER_CALL),
      dropoff,
    });
    if (!answer.ok) {
      return err(
        answer.error.code === 'access.denied'
          ? { code: 'access.denied' }
          : { code: 'ordering.check-unavailable' },
      );
    }
    for (const [sellerId, value] of answer.value) quotes.set(sellerId, value);
  }
  // The GST of every quoted price, in one answer: a quote is a price with tax included, taxed at
  // the strategy's default rate (no category), shown apart from the total.
  const quoted: { sellerId: Id<'Seller'>; method: 'instant' | 'same_day' | 'scheduled' }[] = [];
  for (const seller of planned.plan.sellers) {
    const sellerQuotes = quotes.get(seller.sellerId);
    if (sellerQuotes === undefined) return err({ code: 'ordering.check-unavailable' });
    for (const method of ['instant', 'same_day', 'scheduled'] as const) {
      if (sellerQuotes.quotes[method]?.kind === 'quoted') {
        quoted.push({ sellerId: seller.sellerId, method });
      }
    }
  }
  const taxOf = new Map<string, { tax: bigint; rateBps: number }>();
  if (quoted.length > 0) {
    const taxed = await deps.tax.calculateTax(
      context,
      quoted.map(({ sellerId, method }) => {
        const quote = quotes.get(sellerId)!.quotes[method];
        return {
          amount: quote?.kind === 'quoted' ? quote.quote.total.amount : 0n,
          taxInclusive: true,
          categoryCode: null,
        };
      }),
    );
    if (!taxed.ok || taxed.value.lines.length !== quoted.length) {
      return err(
        !taxed.ok && taxed.error.code === 'access.denied'
          ? { code: 'access.denied' }
          : { code: 'ordering.check-unavailable' },
      );
    }
    quoted.forEach(({ sellerId, method }, index) => {
      const line = taxed.value.lines[index]!;
      taxOf.set(`${sellerId}/${method}`, { tax: line.tax, rateBps: line.rateBps });
    });
  }
  return ok(
    planned.plan.sellers.map((seller): SellerDeliveryOptions => {
      const sellerQuotes = quotes.get(seller.sellerId)!;
      const prices: Partial<Record<'instant' | 'same_day' | 'scheduled', MethodPrice>> = {};
      for (const method of ['instant', 'same_day', 'scheduled'] as const) {
        const quote = sellerQuotes.quotes[method];
        if (quote === undefined) continue;
        if (quote.kind !== 'quoted') {
          prices[method] = { state: quote.kind };
          continue;
        }
        const tax = taxOf.get(`${seller.sellerId}/${method}`)!;
        prices[method] = {
          state: 'quoted',
          price: {
            quoteId: quote.quote.quoteId,
            total: quote.quote.total,
            tax: { amount: tax.tax, currency: quote.quote.total.currency },
            taxRateBps: tax.rateBps,
            etaMinutes: quote.quote.etaMinutes,
            validUntil: quote.quote.validUntil.toString(),
          },
        };
      }
      return {
        sellerId: seller.sellerId,
        availability: sellerQuotes.availability,
        pickupPostcode: sellerQuotes.pickupPostcode,
        prices,
      };
    }),
  );
}
