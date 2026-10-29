import { describe, expect, it } from 'vitest';
import { payOrder } from '../src/checkout/actions.ts';
import { parseCardSetup } from '../src/storefront/config.ts';

const aud = (amount: number) => ({ amount, currency: 'AUD' });

/** A seller's delivery as the browser sends it. */
function choice(method: string, quoteId: string | null, total: number, window: unknown = null) {
  return { method, quoteId, window, total: aud(total) };
}

/** A Pay request for the sample cart, changed by `over`. */
function request(over: Record<string, unknown> = {}) {
  return {
    method: 'card',
    confirmationToken: null,
    address: { kind: 'saved', id: 'home' },
    lines: { brisket: 1, sourdough: 1 },
    delivery: {
      kedron: choice('instant', 'sample-kedron-instant', 1290),
      paddington: choice('pickup', null, 0),
    },
    discountCode: null,
    total: aud(5540 + 1290),
    ...over,
  };
}

describe('Pay (server action, sample ordering)', () => {
  it('places a sample order for the card tile and sends the Stripe tile to its page', async () => {
    expect(await payOrder(request())).toEqual({ kind: 'paid', reference: 'MP-20481' });
    expect(await payOrder(request({ method: 'stripe' }))).toEqual({
      kind: 'redirect',
      url: '/checkout/payment',
    });
  });

  it('says what changed before charging: a delivery price, then stock', async () => {
    const answer = await payOrder(
      request({
        delivery: { kedron: choice('instant', 'sample-kedron-instant', 990) },
      }),
    );
    expect(answer).toMatchObject({
      kind: 'price-changed',
      changes: [{ sellerId: 'kedron', was: aud(990), now: aud(1290) }],
    });
    // A method that is off at the seller cannot be paid for.
    expect(
      await payOrder(
        request({
          delivery: { paddington: choice('same_day', 'sample-paddington-same_day', 990) },
        }),
      ),
    ).toEqual({ kind: 'failed' });
  });

  it('answers failed for a Stripe token until ordering takes card payments', async () => {
    expect(await payOrder(request({ confirmationToken: 'ctoken_1Abc' }))).toEqual({
      kind: 'failed',
    });
  });

  it('refuses a request that is not one, charging nothing', async () => {
    for (const raw of [
      null,
      request({ method: 'paypal' }),
      request({ method: 'stripe', confirmationToken: 'ctoken_1Abc' }),
      request({ confirmationToken: 'tok_visa' }),
      request({ address: { kind: 'saved', id: 'a b' } }),
      request({ lines: {} }),
      request({ lines: { brisket: 0 } }),
      request({ lines: { brisket: 1.5 } }),
      request({ lines: { brisket: 100 } }),
      request({ lines: ['brisket'] }),
      request({ lines: { nothing: 1 } }),
      request({ delivery: { kedron: choice('drone', 'q1', 1290) } }),
      request({ delivery: { kedron: choice('instant', null, 1290) } }),
      request({ delivery: { kedron: choice('instant', 'a b', 1290) } }),
      request({ delivery: { kedron: choice('pickup', 'q1', 0) } }),
      request({ delivery: { kedron: choice('instant', 'q1', 1290, { start: 'x', end: 'y' }) } }),
      request({ delivery: { kedron: choice('scheduled', 'q1', 790) } }),
      request({ delivery: { kedron: choice('scheduled', 'q1', 790, { start: 'x', end: 'y' }) } }),
      request({
        delivery: {
          kedron: { ...choice('instant', 'q1', 1290), total: { amount: 1290, currency: 'NZD' } },
        },
      }),
      request({ delivery: { kedron: { method: 'instant', quoteId: 'q1', window: null } } }),
      request({ total: { amount: -1, currency: 'AUD' } }),
      request({ total: { amount: 1, currency: 'aud' } }),
      request({ discountCode: '<b>' }),
      request({ lines: JSON.parse('{"__proto__": 1}') as unknown }),
      request({ lines: { constructor: 1 } }),
      request({ delivery: JSON.parse('{"__proto__": {"method": "pickup"}}') as unknown }),
      request({ delivery: { toString: choice('pickup', null, 0) } }),
    ])
      expect(await payOrder(raw)).toEqual({ kind: 'failed' });
  });
});

describe('card setup (STRIPE_TEST_PUBLISHABLE_KEY)', () => {
  it('shows the sample without a key and Stripe with a test key', () => {
    expect(parseCardSetup(undefined)).toEqual({ kind: 'sample' });
    expect(parseCardSetup('  ')).toEqual({ kind: 'sample' });
    expect(parseCardSetup('pk_test_51AbcDEF')).toEqual({
      kind: 'stripe',
      publishableKey: 'pk_test_51AbcDEF',
    });
  });

  it('stops start-up on a live key or anything else: Stripe stays in test mode', () => {
    for (const key of ['pk_live_51AbcDEF', 'sk_test_51AbcDEF', 'pk_test_', 'pk_test_51 Abc'])
      expect(() => parseCardSetup(key)).toThrow(/test-mode key/);
  });
});
