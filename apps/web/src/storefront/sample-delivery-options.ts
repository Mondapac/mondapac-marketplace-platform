import 'server-only';
import type {
  DeliveryMethod,
  MethodOption,
  MethodPrice,
  MethodReason,
  Money,
  SellerDeliveryOptions,
} from './types.ts';

// Sample delivery options of the checkout, while the buyer's session and cart are not live. They
// stand in for `POST orders/delivery-quotes` and have the same shape. Each sample seller is
// built to show one state of the picker: all four methods open (Kedron), same day closed for the
// day (Paddington), instant not offered (Sunnybank), no pickup address (Inala), a price that
// cannot be asked now and a method no courier carries (Logan Road). Every value is a sample.

const money = (amount: number): Money => ({ amount, currency: 'AUD' });

/** Totals in minor units, GST included, by method; the sample strategy's GST is 1/11. */
const TOTALS: Readonly<Record<'instant' | 'same_day' | 'scheduled', number>> = {
  instant: 1290,
  same_day: 990,
  scheduled: 790,
};

const FAR_FUTURE = '2099-01-01T00:00:00Z';

function quoted(sellerId: string, method: 'instant' | 'same_day' | 'scheduled'): MethodPrice {
  const total = TOTALS[method];
  return {
    state: 'quoted',
    quoteId: `sample-${sellerId}-${method}`,
    total: money(total),
    tax: money(Math.round(total / 11)),
    etaMinutes: method === 'instant' ? 45 : null,
    validUntil: FAR_FUTURE,
  };
}

const unavailable = (method: DeliveryMethod, reason: MethodReason): MethodOption => ({
  method,
  available: false,
  reason,
  price: null,
});

function option(
  sellerId: string,
  method: DeliveryMethod,
  state: MethodReason | 'failed' | 'no-fleet' | null,
): MethodOption {
  if (state === 'seller-unsupported' || state === 'past-cut-off' || state === 'no-pickup-address')
    return unavailable(method, state);
  if (method === 'pickup')
    return { method, available: true, reason: null, price: { state: 'free' } };
  if (state === 'failed' || state === 'no-fleet')
    return { method, available: true, reason: null, price: { state } };
  return { method, available: true, reason: null, price: quoted(sellerId, method) };
}

/** What differs from "everything open" per sample seller. */
const VARIANTS: Readonly<
  Record<string, Partial<Record<DeliveryMethod, MethodReason | 'failed' | 'no-fleet'>>>
> = {
  paddington: { same_day: 'past-cut-off' },
  sunnybank: { instant: 'seller-unsupported' },
  inala: { pickup: 'no-pickup-address' },
  'logan-road': { instant: 'failed', scheduled: 'no-fleet' },
};

const ORDER: readonly DeliveryMethod[] = ['pickup', 'instant', 'same_day', 'scheduled'];

/** One sample seller's options; the same for every address (every sample address is in range). */
export function sampleOptionsOf(sellerId: string): SellerDeliveryOptions {
  const variant = Object.hasOwn(VARIANTS, sellerId) ? VARIANTS[sellerId]! : {};
  return {
    zone: 'Australia/Brisbane',
    sameDayCutoff: '12:00',
    scheduledDaysAhead: 7,
    scheduledWindowMinutes: 120,
    pickupPostcode: variant.pickup === 'no-pickup-address' ? null : '4031',
    methods: ORDER.map((method) => option(sellerId, method, variant[method] ?? null)),
  };
}

export function sampleDeliveryOptions(
  sellerIds: readonly string[],
): Record<string, SellerDeliveryOptions> {
  return Object.fromEntries(sellerIds.map((id) => [id, sampleOptionsOf(id)]));
}
