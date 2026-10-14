import { Temporal } from '@mondapac/shared-kernel';
import { StripeCheckoutGateway, type StripeFetch } from './stripe-checkout-gateway';

// The Stripe adapter with a fake `fetch`: the request it builds (manual capture, card only, one
// package per seller, the stored idempotency key), the failure it returns for each kind of
// answer, and that the secret key never reaches an error.

const KEY = 'sk_test_unit_secret_1234567890';
const REQUEST = {
  orderId: '01990000-0000-7000-8000-0000000000aa',
  marketId: 'AU',
  currency: 'AUD',
  packages: [
    { label: 'MondaPac order, package 1', amount: 2099n },
    { label: 'MondaPac order, package 2', amount: 750n },
  ],
  successUrl: 'https://storefront.au.mondapac.test/checkout/success?order=x',
  cancelUrl: 'https://storefront.au.mondapac.test/checkout/cancelled?order=x',
  expiresAt: Temporal.Instant.from('2026-10-14T10:30:00Z'),
  idempotencyKey: 'checkout-01990000-0000-7000-8000-0000000000aa',
};

function fake(status: number, body: unknown = {}) {
  const calls: { url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
  const fetchFn: StripeFetch = (url, init) => {
    calls.push({ url, headers: init.headers, body: new URLSearchParams(init.body) });
    return Promise.resolve({ status, json: () => Promise.resolve(body) });
  };
  return { calls, fetchFn };
}

describe('StripeCheckoutGateway', () => {
  it('opens a manual-capture, card-only session with one line per seller package', async () => {
    const { calls, fetchFn } = fake(200, {
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    const gateway = new StripeCheckoutGateway(KEY, fetchFn);

    const session = await gateway.createSession(REQUEST);

    expect(session).toEqual({
      ok: true,
      value: { sessionId: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' },
    });
    const [call] = calls;
    expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call?.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      'Idempotency-Key': REQUEST.idempotencyKey,
    });
    const form = call!.body;
    expect(form.get('mode')).toBe('payment');
    expect(form.get('payment_intent_data[capture_method]')).toBe('manual');
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.get('payment_method_types[1]')).toBeNull();
    expect(form.get('client_reference_id')).toBe(REQUEST.orderId);
    expect(form.get('expires_at')).toBe(String(Date.parse('2026-10-14T10:30:00Z') / 1000));
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2099');
    expect(form.get('line_items[1][price_data][unit_amount]')).toBe('750');
    expect(form.get('line_items[0][price_data][currency]')).toBe('aud');
    expect(form.get('success_url')).toBe(REQUEST.successUrl);
    expect(form.toString()).not.toContain(KEY);
  });

  it('captures and voids with the given key, and does nothing for a malformed id', async () => {
    const { calls, fetchFn } = fake(200, { id: 'pi_test_1' });
    const gateway = new StripeCheckoutGateway(KEY, fetchFn);

    expect(await gateway.capture('pi_test_1', 'capture-1')).toEqual({ ok: true, value: true });
    expect(await gateway.voidAuthorisation('pi_test_1', 'void-1')).toEqual({
      ok: true,
      value: true,
    });
    expect(calls.map((c) => [c.url, c.headers['Idempotency-Key']])).toEqual([
      ['https://api.stripe.com/v1/payment_intents/pi_test_1/capture', 'capture-1'],
      ['https://api.stripe.com/v1/payment_intents/pi_test_1/cancel', 'void-1'],
    ]);
    expect(await gateway.capture('../pi', 'k')).toEqual({
      ok: false,
      error: { code: 'payment.provider-rejected' },
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [500, 'payment.provider-unavailable'],
    [429, 'payment.provider-unavailable'],
    [409, 'payment.provider-unavailable'],
    [400, 'payment.provider-rejected'],
    [402, 'payment.provider-rejected'],
  ])('maps a %i answer to %s without echoing the key or the body', async (status, code) => {
    const { fetchFn } = fake(status, { error: { message: `bad ${KEY}` } });
    const gateway = new StripeCheckoutGateway(KEY, fetchFn);

    const result = await gateway.createSession(REQUEST);

    expect(result).toEqual({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('treats a network error, a timeout and a session without an https url as unavailable', async () => {
    const boom = new StripeCheckoutGateway(KEY, () => Promise.reject(new Error(`down ${KEY}`)));
    expect(await boom.createSession(REQUEST)).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });

    const slow = new StripeCheckoutGateway(
      KEY,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      5,
    );
    expect(await slow.createSession(REQUEST)).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });

    const odd = new StripeCheckoutGateway(
      KEY,
      fake(200, { id: 'cs_test_1', url: 'http://x' }).fetchFn,
    );
    expect(await odd.createSession(REQUEST)).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
  });

  it('sends nothing without a key (fail closed)', async () => {
    const { calls, fetchFn } = fake(200, { id: 'cs_test_1', url: 'https://x' });
    const gateway = new StripeCheckoutGateway(null, fetchFn);

    expect(await gateway.createSession(REQUEST)).toEqual({
      ok: false,
      error: { code: 'payment.provider-unavailable' },
    });
    await gateway.expireSession('cs_test_1');
    expect(calls).toEqual([]);
  });

  it('expires a session best effort and ignores a malformed id', async () => {
    const { calls, fetchFn } = fake(200, {});
    const gateway = new StripeCheckoutGateway(KEY, fetchFn);

    await gateway.expireSession('cs_test_1');
    await gateway.expireSession('cs_test_1/../../x');

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.stripe.com/v1/checkout/sessions/cs_test_1/expire',
    ]);
  });
});
