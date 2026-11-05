import { StripeCheckoutSessionReader, type StripeGet } from './stripe-session-reader';

// Reading a PaymentIntent of the card payment again from Stripe: only the fields payments acts on
// are kept, and a body that is not a well-formed PaymentIntent is not an answer.

const KEY = 'sk_test_unit_secret_1234567890';
const body = (fields: Record<string, unknown> = {}) => ({
  id: 'pi_1UnitIntent',
  object: 'payment_intent',
  livemode: false,
  status: 'requires_capture',
  currency: 'aud',
  amount_capturable: 3349,
  metadata: { order_id: 'order-1', market_id: 'AU', payment_flow: 'card-intent' },
  payment_method: {
    id: 'pm_1',
    object: 'payment_method',
    type: 'card',
    card: { brand: 'visa', last4: '4242' },
  },
  latest_charge: 'ch_secretish',
  ...fields,
});

function fake(status: number, answer: unknown) {
  const urls: string[] = [];
  const fetchFn: StripeGet = (url) => {
    urls.push(url);
    return Promise.resolve({ status, json: () => Promise.resolve(answer) });
  };
  return { urls, fetchFn };
}

describe('StripeCheckoutSessionReader.readPaymentIntent', () => {
  it('reads one PaymentIntent and keeps only what payments acts on', async () => {
    const { urls, fetchFn } = fake(200, body());

    const read = await new StripeCheckoutSessionReader(KEY, fetchFn).readPaymentIntent(
      'pi_1UnitIntent',
    );

    expect(urls).toEqual([
      'https://api.stripe.com/v1/payment_intents/pi_1UnitIntent?expand[]=payment_method',
    ]);
    expect(read).toEqual({
      ok: true,
      value: {
        id: 'pi_1UnitIntent',
        livemode: false,
        status: 'requires_capture',
        currency: 'aud',
        amountCapturable: 3349n,
        metadataOrderId: 'order-1',
        metadataMarketId: 'AU',
        metadataPaymentFlow: 'card-intent',
        paymentMethodType: 'card',
        cardBrand: 'visa',
      },
    });
    // Nothing else of the card is kept.
    expect(Object.keys(read.ok ? read.value : {}).sort()).not.toContain('last4');
  });

  it('answers no method when the payment method was not expanded or is absent', async () => {
    for (const payment_method of ['pm_1', null, undefined]) {
      const read = await new StripeCheckoutSessionReader(
        KEY,
        fake(200, body({ payment_method })).fetchFn,
      ).readPaymentIntent('pi_1UnitIntent');

      expect(read.ok && [read.value.paymentMethodType, read.value.cardBrand]).toEqual([null, null]);
    }
  });

  it('refuses a malformed id without a call and answers rejected', async () => {
    const { urls, fetchFn } = fake(200, body());

    const read = await new StripeCheckoutSessionReader(KEY, fetchFn).readPaymentIntent('cs_test_1');

    expect(read).toEqual({ ok: false, error: { code: 'payment.provider-rejected' } });
    expect(urls).toEqual([]);
  });

  it.each([
    ['an object that is not a PaymentIntent', { object: 'checkout.session' }],
    ['no livemode flag', body({ livemode: undefined })],
    ['no capturable amount', body({ amount_capturable: undefined })],
    ['a negative capturable amount', body({ amount_capturable: -1 })],
  ])('does not accept %s', async (_name, answer) => {
    const read = await new StripeCheckoutSessionReader(
      KEY,
      fake(200, answer).fetchFn,
    ).readPaymentIntent('pi_1UnitIntent');

    expect(read).toEqual({ ok: false, error: { code: 'payment.provider-unavailable' } });
  });

  it('maps 404 to rejected and 5xx to unavailable', async () => {
    expect(
      await new StripeCheckoutSessionReader(KEY, fake(404, {}).fetchFn).readPaymentIntent(
        'pi_1UnitIntent',
      ),
    ).toEqual({ ok: false, error: { code: 'payment.provider-rejected' } });
    expect(
      await new StripeCheckoutSessionReader(KEY, fake(503, {}).fetchFn).readPaymentIntent(
        'pi_1UnitIntent',
      ),
    ).toEqual({ ok: false, error: { code: 'payment.provider-unavailable' } });
  });
});
