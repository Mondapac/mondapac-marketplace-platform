import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../src/account/customer-api.ts';
import { apiMoney, orderBody, payLive, type LivePayDeps } from '../src/checkout/live-pay.ts';
import type { PayRequest, SellerDeliveryOptions } from '../src/storefront/types.ts';

const ORDER = '0b6f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ADDRESS = '7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';
const SELLER_A = '11111111-1111-4111-8111-111111111111';
const SELLER_B = '22222222-2222-4222-8222-222222222222';
const OFFER = '33333333-3333-4333-8333-333333333333';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const KEY = `${OFFER}:${VARIANT}`;

const nzd = (amount: number) => ({ amount, currency: 'NZD' });

function request(over: Partial<PayRequest> = {}): PayRequest {
  return {
    method: 'card',
    confirmationToken: 'ctoken_abc123',
    address: { kind: 'saved', id: ADDRESS },
    lines: { [KEY]: 3 },
    delivery: {
      [SELLER_A]: { method: 'instant', quoteId: 'q-a', window: null, total: nzd(990) },
      [SELLER_B]: {
        method: 'scheduled',
        quoteId: 'q-b',
        window: { start: '2026-11-23T01:00:00Z', end: '2026-11-23T03:00:00Z' },
        total: nzd(500),
      },
    },
    discountCode: null,
    total: nzd(5490),
    ...over,
  };
}

const ok = <T>(value: T): ApiResult<T> => ({ kind: 'ok', value });
const invalid = (code: string, details: Record<string, unknown> = {}): ApiResult<never> => ({
  kind: 'invalid',
  code,
  fields: [],
  details,
});

const OPTIONS: Readonly<Record<string, SellerDeliveryOptions>> = {};

function deps(over: Partial<LivePayDeps> = {}): LivePayDeps {
  return {
    payByCard: vi.fn(() =>
      Promise.resolve(ok({ orderId: ORDER, status: 'authorised' as const, clientSecret: null })),
    ),
    startHostedCheckout: vi.fn(() =>
      Promise.resolve(ok({ orderId: ORDER, checkoutUrl: 'https://checkout.stripe.com/c/pay/x' })),
    ),
    handleNextAction: vi.fn(() => Promise.resolve('ok' as const)),
    readDeliveryOptions: vi.fn(() => Promise.resolve(ok(OPTIONS))),
    readStockLeft: vi.fn(() => Promise.resolve({ [KEY]: 1 })),
    ...over,
  };
}

describe('live Pay: what goes to the API', () => {
  it('sends the saved address, the methods with their stored quotes and windows, notes and code; never a price', () => {
    const body = orderBody(request({ discountCode: 'WELCOME-5' }), {
      [SELLER_A]: '  Ring the bell  ',
      [SELLER_B]: '   ',
      'not-in-cart': 'dropped',
    });
    expect(body).toEqual({
      addressId: ADDRESS,
      deliveryMethods: {
        [SELLER_A]: { method: 'instant', quoteId: 'q-a' },
        [SELLER_B]: {
          method: 'scheduled',
          quoteId: 'q-b',
          windowStart: '2026-11-23T01:00:00Z',
          windowEnd: '2026-11-23T03:00:00Z',
        },
      },
      sellerNotes: { [SELLER_A]: 'Ring the bell' },
      code: 'WELCOME-5',
    });
    expect(JSON.stringify(body)).not.toContain('990');
  });

  it('sends no quote for a pickup and refuses an address that is not saved', () => {
    const pickup = request({
      delivery: { [SELLER_A]: { method: 'pickup', quoteId: null, window: null, total: nzd(0) } },
    });
    expect(orderBody(pickup, {})?.deliveryMethods).toEqual({ [SELLER_A]: { method: 'pickup' } });
    expect(orderBody(request({ address: { kind: 'new', postcode: '1010' } }), {})).toBeNull();
  });

  it('pays by card with the token and the total the buyer saw', async () => {
    const d = deps();
    expect(await payLive(request(), {}, d)).toEqual({
      kind: 'paid',
      reference: ORDER.slice(0, 8).toUpperCase(),
    });
    expect(d.payByCard).toHaveBeenCalledWith(expect.anything(), 'ctoken_abc123', nzd(5490));
    expect(d.startHostedCheckout).not.toHaveBeenCalled();
  });

  it('sends the Stripe tile to the hosted page and never calls Pay', async () => {
    const d = deps();
    expect(await payLive(request({ method: 'stripe', confirmationToken: null }), {}, d)).toEqual({
      kind: 'redirect',
      url: 'https://checkout.stripe.com/c/pay/x',
    });
    expect(d.payByCard).not.toHaveBeenCalled();
  });

  it('never pays a card without a token, or a new address', async () => {
    const d = deps();
    expect(await payLive(request({ confirmationToken: null }), {}, d)).toEqual({ kind: 'failed' });
    expect(await payLive(request({ address: { kind: 'new', postcode: '1010' } }), {}, d)).toEqual({
      kind: 'failed',
    });
    expect(d.payByCard).not.toHaveBeenCalled();
  });
});

describe('live Pay: the bank check and the refusals', () => {
  it('runs the bank check for requires-action and is paid only when it passes', async () => {
    const started = ok({
      orderId: ORDER,
      status: 'requires-action' as const,
      clientSecret: 'pi_secret',
    });
    const passed = deps({ payByCard: () => Promise.resolve(started) });
    expect((await payLive(request(), {}, passed)).kind).toBe('paid');
    expect(passed.handleNextAction).toHaveBeenCalledWith('pi_secret');

    const refused = deps({
      payByCard: () => Promise.resolve(started),
      handleNextAction: () => Promise.resolve('declined'),
    });
    expect(await payLive(request(), {}, refused)).toEqual({ kind: 'declined' });
  });

  it('maps a declined or not accepted card to declined', async () => {
    for (const code of ['ordering.card-declined', 'ordering.card-not-accepted']) {
      const d = deps({ payByCard: () => Promise.resolve(invalid(code)) });
      expect(await payLive(request(), {}, d)).toEqual({ kind: 'declined' });
    }
  });

  it('shows a moved delivery quote with the fresh options', async () => {
    const d = deps({
      payByCard: () =>
        Promise.resolve(
          invalid('ordering.delivery-quote-changed', {
            quotes: [
              { sellerId: SELLER_A, quoteId: 'q-a2', total: { amount: '1190', currency: 'NZD' } },
              { sellerId: 'unknown', quoteId: 'q', total: { amount: '1', currency: 'NZD' } },
            ],
          }),
        ),
    });
    expect(await payLive(request(), {}, d)).toEqual({
      kind: 'price-changed',
      changes: [{ sellerId: SELLER_A, was: nzd(990), now: nzd(1190) }],
      options: OPTIONS,
    });
    expect(d.readDeliveryOptions).toHaveBeenCalledWith(ADDRESS);
  });

  it('shows the new order total when the server priced it differently', async () => {
    const d = deps({
      payByCard: () =>
        Promise.resolve(
          invalid('ordering.price-changed', { total: { amount: '5990', currency: 'NZD' } }),
        ),
    });
    expect(await payLive(request(), {}, d)).toEqual({
      kind: 'total-changed',
      was: nzd(5490),
      now: nzd(5990),
    });
  });

  it('shows what stock is left, from a fresh cart read', async () => {
    const d = deps({
      payByCard: () =>
        Promise.resolve(
          invalid('ordering.stock-insufficient', {
            lines: [{ offerId: OFFER, variantId: VARIANT, reason: 'not-enough' }],
          }),
        ),
    });
    expect(await payLive(request(), {}, d)).toEqual({
      kind: 'stock-changed',
      changes: [{ itemId: KEY, was: 3, now: 1 }],
    });
    // The line is not in the fresh cart any more: none left.
    const gone = deps({
      payByCard: d.payByCard,
      readStockLeft: () => Promise.resolve({ [KEY]: 0 }),
    });
    expect(await payLive(request(), {}, gone)).toEqual({
      kind: 'stock-changed',
      changes: [{ itemId: KEY, was: 3, now: 0 }],
    });
  });

  it('says where to look for what Pay again cannot fix', async () => {
    const cases: [string, string][] = [
      ['ordering.discount-code-not-applied', 'discount'],
      ['ordering.address-not-found', 'address'],
      ['ordering.outside-delivery-area', 'address'],
      ['ordering.delivery-method-unavailable', 'delivery'],
      ['ordering.pickup-unavailable', 'delivery'],
      ['ordering.cart-not-ready', 'cart'],
      ['ordering.cart-empty', 'cart'],
      ['ordering.cart-not-purchasable', 'cart'],
    ];
    for (const [code, reason] of cases) {
      const d = deps({ payByCard: () => Promise.resolve(invalid(code)) });
      expect(await payLive(request(), {}, d)).toEqual({ kind: 'refused', reason });
    }
  });

  it('asks for a new log-in when the session ended, and says how long to wait when throttled', async () => {
    const out = deps({
      payByCard: () => Promise.resolve({ kind: 'signed-out', code: 'access.unauthenticated' }),
    });
    expect(await payLive(request(), {}, out)).toEqual({ kind: 'signed-out' });
    const slow = deps({
      payByCard: () => Promise.resolve({ kind: 'throttled', retryAfterSeconds: 90 }),
    });
    expect(await payLive(request(), {}, slow)).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 90,
    });
    const unknown = deps({
      payByCard: () => Promise.resolve({ kind: 'throttled', retryAfterSeconds: undefined }),
    });
    expect(await payLive(request(), {}, unknown)).toEqual({
      kind: 'throttled',
      retryAfterSeconds: null,
    });
  });

  it('asks the hosted page once more after conflict.retry, never a card payment', async () => {
    let calls = 0;
    const hosted = deps({
      startHostedCheckout: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? invalid('conflict.retry')
            : ok({ orderId: ORDER, checkoutUrl: 'https://checkout.stripe.com/c/pay/y' }),
        );
      },
    });
    expect(
      await payLive(request({ method: 'stripe', confirmationToken: null }), {}, hosted),
    ).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/y' });
    const card = deps({ payByCard: vi.fn(() => Promise.resolve(invalid('conflict.retry'))) });
    expect(await payLive(request(), {}, card)).toEqual({ kind: 'failed' });
    expect(card.payByCard).toHaveBeenCalledTimes(1);
  });

  it('never calls an item sold out when the fresh count is unknown', async () => {
    const refusal = (reason: string) => () =>
      Promise.resolve(
        invalid('ordering.stock-insufficient', {
          lines: [{ offerId: OFFER, variantId: VARIANT, reason }],
        }),
      );
    // The cart could not be read: no count is made up.
    const unread = deps({
      payByCard: refusal('not-enough'),
      readStockLeft: () => Promise.resolve(null),
    });
    expect(await payLive(request(), {}, unread)).toEqual({ kind: 'refused', reason: 'stock' });
    // A line with no low-stock count says nothing new either.
    const plenty = deps({
      payByCard: refusal('over-limit'),
      readStockLeft: () => Promise.resolve({ [KEY]: Number.MAX_SAFE_INTEGER }),
    });
    expect(await payLive(request(), {}, plenty)).toEqual({ kind: 'refused', reason: 'stock' });
    // Sold out is the API's own word for it.
    const out = deps({ payByCard: refusal('out'), readStockLeft: () => Promise.resolve(null) });
    expect(await payLive(request(), {}, out)).toEqual({
      kind: 'stock-changed',
      changes: [{ itemId: KEY, was: 3, now: 0 }],
    });
  });

  it('answers failed for an unknown refusal or a broken answer', async () => {
    const answers: ApiResult<never>[] = [
      invalid('ordering.something-new'),
      invalid('ordering.price-changed', { total: { amount: '-1', currency: 'NZD' } }),
      invalid('ordering.delivery-quote-changed', { quotes: 'x' }),
      invalid('ordering.stock-insufficient', { lines: 'x' }),
      { kind: 'failed' },
    ];
    for (const answer of answers) {
      const d = deps({
        payByCard: () => Promise.resolve(answer),
        startHostedCheckout: () => Promise.resolve(answer),
      });
      expect(await payLive(request(), {}, d)).toEqual({ kind: 'failed' });
      expect(await payLive(request({ method: 'stripe', confirmationToken: null }), {}, d)).toEqual({
        kind: 'failed',
      });
    }
  });

  it('cuts a long note by characters, never inside an emoji', () => {
    const note = `${'a'.repeat(199)}😀😀`;
    const body = orderBody(request(), { [SELLER_A]: note });
    expect(body?.sellerNotes?.[SELLER_A]).toBe(`${'a'.repeat(199)}😀`);
  });

  it('reads money bodies strictly', () => {
    expect(apiMoney({ amount: '1999', currency: 'AUD' })).toEqual({
      amount: 1999,
      currency: 'AUD',
    });
    expect(apiMoney({ amount: 1999, currency: 'AUD' })).toBeNull();
    expect(apiMoney({ amount: '19.99', currency: 'AUD' })).toBeNull();
    expect(apiMoney({ amount: '1', currency: 'aud' })).toBeNull();
  });
});
