import { StripeCheckoutSessionReader, type StripeGet } from './stripe-session-reader';

// The Checkout session reader against a fake `fetch`: the exact request (GET, the expanded
// PaymentIntent, the key only in the Authorization header), the narrowing of Stripe's answer, and
// every failure as a code without Stripe's text.

const KEY = 'sk_test_abcdefgh12345678';

const answer = (status: number, body: unknown) => () =>
  Promise.resolve({ status, json: () => Promise.resolve(body) });

const SESSION = {
  id: 'cs_test_a1',
  object: 'checkout.session',
  livemode: false,
  status: 'complete',
  payment_status: 'unpaid',
  client_reference_id: 'order-1',
  metadata: { order_id: 'order-1', market_id: 'AU' },
  payment_intent: {
    id: 'pi_test_b2',
    object: 'payment_intent',
    status: 'requires_capture',
    currency: 'aud',
    amount_capturable: 3000,
    amount_received: 0,
    payment_method: 'pm_card_should_not_be_kept',
  },
};

describe('StripeCheckoutSessionReader', () => {
  it('reads the session with its PaymentIntent and keeps only what payments needs', async () => {
    const calls: { url: string; init: Parameters<StripeGet>[1] }[] = [];
    const reader = new StripeCheckoutSessionReader(KEY, (url, init) => {
      calls.push({ url, init });
      return answer(200, SESSION)();
    });

    const read = await reader.readCheckoutSession('cs_test_a1');

    expect(read).toEqual({
      ok: true,
      value: {
        id: 'cs_test_a1',
        livemode: false,
        status: 'complete',
        paymentStatus: 'unpaid',
        clientReferenceId: 'order-1',
        metadataOrderId: 'order-1',
        metadataMarketId: 'AU',
        paymentIntent: {
          id: 'pi_test_b2',
          status: 'requires_capture',
          currency: 'aud',
          amountCapturable: 3000n,
          amountReceived: 0n,
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.stripe.com/v1/checkout/sessions/cs_test_a1?expand[]=payment_intent',
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('reads a session without a PaymentIntent', async () => {
    const reader = new StripeCheckoutSessionReader(
      KEY,
      answer(200, { ...SESSION, status: 'expired', payment_intent: null }),
    );

    const read = await reader.readCheckoutSession('cs_test_a1');

    expect(read.ok && read.value.paymentIntent).toBeNull();
  });

  it.each([
    ['a server error', answer(500, {})],
    ['a rate limit', answer(429, {})],
    ['a network error', () => Promise.reject(new Error('boom'))],
    ['an answer that is not a session', answer(200, { object: 'payment_intent' })],
    [
      'a malformed PaymentIntent',
      answer(200, {
        ...SESSION,
        payment_intent: { ...SESSION.payment_intent, amount_capturable: -1 },
      }),
    ],
    ['an unexpanded PaymentIntent', answer(200, { ...SESSION, payment_intent: 'pi_test_b2' })],
  ])('answers unavailable on %s', async (_label, fetchFn) => {
    const reader = new StripeCheckoutSessionReader(KEY, fetchFn);

    expect(await reader.readCheckoutSession('cs_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
  });

  it('answers rejected on a 4xx and on a malformed id, which is never sent', async () => {
    let calls = 0;
    const reader = new StripeCheckoutSessionReader(KEY, () => {
      calls += 1;
      return answer(404, { error: { message: 'No such checkout.session' } })();
    });

    expect(await reader.readCheckoutSession('cs_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-rejected' },
    });
    expect(await reader.readCheckoutSession('cs_../../v1/charges')).toEqual({
      ok: false,
      error: { code: 'payment.provider-rejected' },
    });
    expect(calls).toBe(1);
  });

  it('calls nothing without a key', async () => {
    const reader = new StripeCheckoutSessionReader(null, () => {
      throw new Error('must not be called');
    });

    expect(await reader.readCheckoutSession('cs_test_a1')).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
  });
});
