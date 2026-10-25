import { describe, expect, it } from 'vitest';
import { payOrder } from '../src/checkout/actions.ts';
import { parseCardSetup } from '../src/storefront/config.ts';

const aud = (amount: number) => ({ amount, currency: 'AUD' });

/** A Pay request for the sample cart, changed by `over`. */
function request(over: Record<string, unknown> = {}) {
  return {
    method: 'card',
    confirmationToken: null,
    address: { kind: 'saved', id: 'home' },
    lines: { brisket: 1, sourdough: 1 },
    delivery: { kedron: { speed: 'express', fee: aud(1290) }, paddington: { speed: 'scheduled' } },
    discountCode: null,
    total: aud(7330),
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

  it('says what changed before charging: an Express price, then stock', async () => {
    expect(
      await payOrder(request({ delivery: { kedron: { speed: 'express', fee: aud(990) } } })),
    ).toEqual({
      kind: 'price-changed',
      changes: [{ sellerId: 'kedron', was: aud(990), now: aud(1290) }],
      quotes: { kedron: { kind: 'quote', express: aud(1290) } },
    });
    // Paddington takes no Express order now: its Scheduled fee applies.
    expect(
      await payOrder(request({ delivery: { paddington: { speed: 'express', fee: aud(900) } } })),
    ).toMatchObject({
      kind: 'price-changed',
      changes: [{ sellerId: 'paddington', was: aud(900), now: aud(500) }],
    });
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
      request({ delivery: { kedron: { speed: 'drone' } } }),
      request({ delivery: { kedron: { speed: 'express' } } }),
      request({
        delivery: { kedron: { speed: 'express', fee: { amount: 1290, currency: 'NZD' } } },
      }),
      request({ total: { amount: -1, currency: 'AUD' } }),
      request({ total: { amount: 1, currency: 'aud' } }),
      request({ discountCode: '<b>' }),
      request({ lines: JSON.parse('{"__proto__": 1}') as unknown }),
      request({ lines: { constructor: 1 } }),
      request({ delivery: JSON.parse('{"__proto__": {"speed": "scheduled"}}') as unknown }),
      request({ delivery: { toString: { speed: 'scheduled' } } }),
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
