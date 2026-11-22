import type {
  ApiResult,
  CardPaymentStarted,
  HostedCheckoutStarted,
  OrderRequestBody,
} from '../account/customer-api.ts';
import { orderReference } from '../account/live-orders.ts';
import type { Money, PayAnswer, PayRequest, SellerDeliveryOptions } from '../storefront/types.ts';

// Pay on the real API, from the browser through the same-origin session relay (the CSRF token and
// the session cookie go with it). The Card tile calls `POST orders/pay` with Stripe's confirmation
// token; the Stripe tile calls `POST orders/checkout` and the buyer goes to Stripe's hosted page.
// The server prices the order again and never takes a price from here: the delivery quote ids and
// the total the buyer saw are only compared with its own. Nothing of the card reaches this site.

/** What live Pay needs; injected so the mapping is tested without a browser or an API. */
export interface LivePayDeps {
  readonly payByCard: (
    order: OrderRequestBody,
    confirmationToken: string,
    expectedTotal: Money,
  ) => Promise<ApiResult<CardPaymentStarted>>;
  readonly startHostedCheckout: (
    order: OrderRequestBody,
  ) => Promise<ApiResult<HostedCheckoutStarted>>;
  /** The bank's check (3D Secure) in Stripe's own frame; `ok` once the card holds the money. */
  readonly handleNextAction: (clientSecret: string) => Promise<'ok' | 'declined' | 'failed'>;
  /** The basket's delivery options for the address again, after a quote moved. */
  readonly readDeliveryOptions: (
    addressId: string,
  ) => Promise<ApiResult<Readonly<Record<string, SellerDeliveryOptions>>>>;
  /** How many of each cart item can be bought now (by cart key), after a stock refusal. */
  readonly readStockLeft: () => Promise<Readonly<Record<string, number>> | null>;
}

const MAX_NOTE = 200;

/** The order fields of the request; null for an address the API cannot take (not saved). */
export function orderBody(
  request: PayRequest,
  notes: Readonly<Record<string, string>>,
): OrderRequestBody | null {
  if (request.address.kind !== 'saved') return null;
  const deliveryMethods: Record<string, OrderRequestBody['deliveryMethods'][string]> = {};
  for (const [sellerId, choice] of Object.entries(request.delivery)) {
    deliveryMethods[sellerId] = {
      method: choice.method,
      ...(choice.quoteId === null ? {} : { quoteId: choice.quoteId }),
      ...(choice.window === null
        ? {}
        : { windowStart: choice.window.start, windowEnd: choice.window.end }),
    };
  }
  const sellerNotes: Record<string, string> = {};
  for (const sellerId of Object.keys(request.delivery)) {
    const note = Object.hasOwn(notes, sellerId) ? notes[sellerId]?.trim() : undefined;
    // By characters, not UTF-16 units: an emoji is never cut in half.
    if (note) sellerNotes[sellerId] = Array.from(note).slice(0, MAX_NOTE).join('');
  }
  return {
    addressId: request.address.id,
    deliveryMethods,
    ...(Object.keys(sellerNotes).length > 0 ? { sellerNotes } : {}),
    ...(request.discountCode === null ? {} : { code: request.discountCode }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DIGITS = /^\d{1,15}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

/** A money body of the API (`{ amount: "1999", currency }`), or null. */
export function apiMoney(value: unknown): Money | null {
  if (!isRecord(value)) return null;
  const { amount, currency } = value;
  if (typeof amount !== 'string' || !DIGITS.test(amount)) return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  return { amount: Number(amount), currency };
}

/** Pay through the API. Any answer it does not know is `failed`: nothing is assumed charged. */
export async function payLive(
  request: PayRequest,
  notes: Readonly<Record<string, string>>,
  deps: LivePayDeps,
): Promise<PayAnswer> {
  const order = orderBody(request, notes);
  if (order === null) return { kind: 'failed' };
  if (request.method === 'stripe') {
    let started = await deps.startHostedCheckout(order);
    // A write that met another one (conflict.retry) is asked once more: nothing was made. Only
    // the hosted page: a card's confirmation token is single use.
    if (started.kind === 'invalid' && started.code === 'conflict.retry')
      started = await deps.startHostedCheckout(order);
    if (started.kind === 'ok') return { kind: 'redirect', url: started.value.checkoutUrl };
    return refused(started, request, order.addressId, deps);
  }
  if (request.confirmationToken === null) return { kind: 'failed' };
  const paid = await deps.payByCard(order, request.confirmationToken, request.total);
  if (paid.kind !== 'ok') return refused(paid, request, order.addressId, deps);
  const reference = orderReference(paid.value.orderId);
  if (paid.value.status === 'authorised') return { kind: 'paid', reference };
  // The bank asks the buyer to confirm (3D Secure): Stripe's frame, then the signed event.
  const checked =
    paid.value.clientSecret === null
      ? 'failed'
      : await deps.handleNextAction(paid.value.clientSecret);
  return checked === 'ok' ? { kind: 'paid', reference } : { kind: checked };
}

/** What a refusal of Pay or checkout means for the page. Nothing was charged in any of them. */
async function refused(
  result: Exclude<ApiResult<unknown>, { kind: 'ok' }>,
  request: PayRequest,
  addressId: string,
  deps: LivePayDeps,
): Promise<PayAnswer> {
  if (result.kind === 'signed-out') return { kind: 'signed-out' };
  if (result.kind === 'throttled')
    return { kind: 'throttled', retryAfterSeconds: result.retryAfterSeconds ?? null };
  if (result.kind !== 'invalid') return { kind: 'failed' };
  switch (result.code) {
    case 'ordering.card-declined':
    case 'ordering.card-not-accepted':
      return { kind: 'declined' };
    case 'ordering.delivery-quote-changed':
      return quoteChanged(result.details, request, addressId, deps);
    case 'ordering.price-changed': {
      const now = apiMoney(result.details.total);
      return now === null ? { kind: 'failed' } : { kind: 'total-changed', was: request.total, now };
    }
    case 'ordering.stock-insufficient':
      return stockChanged(result.details, request, deps);
    // What Pay again cannot fix: the page says where to look.
    case 'ordering.discount-code-not-applied':
      return { kind: 'refused', reason: 'discount' };
    case 'ordering.address-not-found':
    case 'ordering.outside-delivery-area':
      return { kind: 'refused', reason: 'address' };
    case 'ordering.delivery-method-unavailable':
    case 'ordering.pickup-unavailable':
      return { kind: 'refused', reason: 'delivery' };
    case 'ordering.cart-not-ready':
    case 'ordering.cart-empty':
    case 'ordering.cart-not-purchasable':
      return { kind: 'refused', reason: 'cart' };
    default:
      return { kind: 'failed' };
  }
}

async function quoteChanged(
  details: Readonly<Record<string, unknown>>,
  request: PayRequest,
  addressId: string,
  deps: LivePayDeps,
): Promise<PayAnswer> {
  const quotes = Array.isArray(details.quotes) ? details.quotes : [];
  const changes = quotes.flatMap((quote: unknown) => {
    if (!isRecord(quote) || typeof quote.sellerId !== 'string') return [];
    const choice = Object.hasOwn(request.delivery, quote.sellerId)
      ? request.delivery[quote.sellerId]
      : undefined;
    const now = apiMoney(quote.total);
    return choice && now ? [{ sellerId: quote.sellerId, was: choice.total, now }] : [];
  });
  const options = await deps.readDeliveryOptions(addressId);
  if (changes.length === 0 || options.kind !== 'ok') return { kind: 'failed' };
  return { kind: 'price-changed', changes, options: options.value };
}

/** The stock refusals that leave none to buy (inventory's InsufficientReason). */
const GONE: ReadonlySet<unknown> = new Set(['out', 'retired']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function stockChanged(
  details: Readonly<Record<string, unknown>>,
  request: PayRequest,
  deps: LivePayDeps,
): Promise<PayAnswer> {
  const lines = Array.isArray(details.lines) ? details.lines : [];
  const refusedLines = lines.flatMap((line: unknown) =>
    isRecord(line) &&
    typeof line.offerId === 'string' &&
    typeof line.variantId === 'string' &&
    UUID.test(line.offerId) &&
    UUID.test(line.variantId)
      ? [{ key: `${line.offerId}:${line.variantId}`, gone: GONE.has(line.reason) }]
      : [],
  );
  const left = await deps.readStockLeft();
  const changes = refusedLines.flatMap(({ key, gone }) => {
    const was = Object.hasOwn(request.lines, key) ? request.lines[key] : undefined;
    if (was === undefined) return [];
    // Sold out or retired: none. Otherwise the fresh cart's count, when it gives one below the
    // quantity; a count that is not known is never shown as "sold out".
    const known = left !== null && Object.hasOwn(left, key) ? left[key] : undefined;
    const now = gone ? 0 : known;
    return now !== undefined && now < was ? [{ itemId: key, was, now }] : [];
  });
  if (changes.length > 0) return { kind: 'stock-changed', changes };
  return refusedLines.length > 0 ? { kind: 'refused', reason: 'stock' } : { kind: 'failed' };
}
