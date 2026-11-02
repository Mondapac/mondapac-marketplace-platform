import { StripeCheckoutGateway, type StripeFetch } from './stripe-checkout-gateway';

// The card payment calls of the Stripe adapter with a fake `fetch`: the ConfirmationToken read and
// the manual-capture PaymentIntent, with the failure it returns for each kind of answer, test
// mode only, and that no secret, token or client secret reaches an error.

const KEY = 'sk_test_unit_secret_1234567890';
const PMC = 'pmc_unitCardsOnly12345';
const TOKEN = 'ctoken_1UnitTestToken';
const ORDER = '01990000-0000-7000-8000-0000000000aa';
const REQUEST = {
  orderId: ORDER,
  marketId: 'AU',
  currency: 'AUD',
  amount: 3349n,
  confirmationToken: TOKEN,
  returnUrl: `https://storefront.au.mondapac.test/checkout/success?order=${ORDER}`,
  idempotencyKey: `checkout-${ORDER}`,
};

function fake(status: number, body: unknown = {}) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: URLSearchParams;
  }[] = [];
  const fetchFn: StripeFetch = (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: new URLSearchParams(init.body),
    });
    return Promise.resolve({ status, json: () => Promise.resolve(body) });
  };
  return { calls, fetchFn };
}

const intent = (fields: Record<string, unknown> = {}) => ({
  id: 'pi_1UnitIntent',
  object: 'payment_intent',
  livemode: false,
  amount: 3349,
  currency: 'aud',
  amount_capturable: 3349,
  status: 'requires_capture',
  metadata: { order_id: ORDER, market_id: 'AU', payment_flow: 'card-intent' },
  ...fields,
});

const token = (fields: Record<string, unknown> = {}) => ({
  id: TOKEN,
  object: 'confirmation_token',
  livemode: false,
  payment_method_preview: { type: 'card', card: { brand: 'visa', last4: '4242' } },
  ...fields,
});

describe('StripeCheckoutGateway card payment', () => {
  describe('readConfirmationToken', () => {
    it('reads the card brand, and keeps nothing else of the card', async () => {
      const { calls, fetchFn } = fake(200, token());
      const gateway = new StripeCheckoutGateway(KEY, PMC, fetchFn);

      const read = await gateway.readConfirmationToken(TOKEN);

      expect(read).toEqual({
        ok: true,
        value: { livemode: false, methodType: 'card', cardBrand: 'visa' },
      });
      expect(calls[0]).toMatchObject({
        url: `https://api.stripe.com/v1/confirmation_tokens/${TOKEN}`,
        method: 'GET',
      });
      expect(JSON.stringify(read)).not.toContain('4242');
    });

    it('answers no brand for a method that is not a card', async () => {
      const { fetchFn } = fake(200, token({ payment_method_preview: { type: 'au_becs_debit' } }));
      const read = await new StripeCheckoutGateway(KEY, PMC, fetchFn).readConfirmationToken(TOKEN);

      expect(read).toEqual({
        ok: true,
        value: { livemode: false, methodType: 'au_becs_debit', cardBrand: null },
      });
    });

    it('refuses a live-mode token, another token than asked for and a malformed id without a call', async () => {
      const live = fake(200, token({ livemode: true }));
      expect(
        await new StripeCheckoutGateway(KEY, PMC, live.fetchFn).readConfirmationToken(TOKEN),
      ).toEqual({
        ok: false,
        error: { code: 'payment.provider-rejected' },
      });

      const other = fake(200, token({ id: 'ctoken_other' }));
      expect(
        await new StripeCheckoutGateway(KEY, PMC, other.fetchFn).readConfirmationToken(TOKEN),
      ).toEqual({ ok: false, error: { code: 'payment.provider-unavailable' } });

      const none = fake(200, token());
      const gateway = new StripeCheckoutGateway(KEY, PMC, none.fetchFn);
      for (const bad of ['pm_123', 'ctoken_a/b', '', 'ctoken_']) {
        expect((await gateway.readConfirmationToken(bad)).ok).toBe(false);
      }
      expect(none.calls).toEqual([]);
    });

    it('does not call Stripe with a live key', async () => {
      const { calls, fetchFn } = fake(200, token());

      const read = await new StripeCheckoutGateway(
        'sk_live_x1234567890',
        PMC,
        fetchFn,
      ).readConfirmationToken(TOKEN);

      expect(read).toEqual({ ok: false, error: { code: 'payment.provider-rejected' } });
      expect(calls).toEqual([]);
    });

    it('maps an unknown token to rejected and a server error to unavailable', async () => {
      expect(
        await new StripeCheckoutGateway(KEY, PMC, fake(404).fetchFn).readConfirmationToken(TOKEN),
      ).toEqual({ ok: false, error: { code: 'payment.provider-rejected' } });
      expect(
        await new StripeCheckoutGateway(KEY, PMC, fake(503).fetchFn).readConfirmationToken(TOKEN),
      ).toEqual({ ok: false, error: { code: 'payment.provider-unavailable' } });
    });
  });

  describe('payByCard', () => {
    it('confirms a manual-capture, card-only PaymentIntent for the order amount with the order key', async () => {
      const { calls, fetchFn } = fake(200, intent());
      const gateway = new StripeCheckoutGateway(KEY, PMC, fetchFn);

      const paid = await gateway.payByCard(REQUEST);

      expect(paid).toEqual({
        ok: true,
        value: { status: 'authorised', paymentIntentId: 'pi_1UnitIntent' },
      });
      const [call] = calls;
      expect(call?.url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(call?.method).toBe('POST');
      expect(call?.headers['Idempotency-Key']).toBe(REQUEST.idempotencyKey);
      const form = call!.body;
      expect(form.get('amount')).toBe('3349');
      expect(form.get('currency')).toBe('aud');
      expect(form.get('capture_method')).toBe('manual');
      expect(form.get('confirm')).toBe('true');
      expect(form.get('confirmation_token')).toBe(TOKEN);
      // Stripe refuses payment_method_types now: the card-only configuration names the methods.
      expect(form.get('payment_method_configuration')).toBe(PMC);
      expect(form.get('payment_method_types[0]')).toBeNull();
      expect(form.get('return_url')).toBe(REQUEST.returnUrl);
      expect(form.get('metadata[order_id]')).toBe(ORDER);
      expect(form.get('metadata[market_id]')).toBe('AU');
      expect(form.get('metadata[payment_flow]')).toBe('card-intent');
      expect(form.toString()).not.toContain(KEY);
    });

    it('hands back the client secret when the bank asks for authentication', async () => {
      const { fetchFn } = fake(
        200,
        intent({
          status: 'requires_action',
          amount_capturable: 0,
          client_secret: 'pi_1UnitIntent_secret_AbCdEf123',
        }),
      );

      const paid = await new StripeCheckoutGateway(KEY, PMC, fetchFn).payByCard(REQUEST);

      expect(paid).toEqual({
        ok: true,
        value: {
          status: 'requires-action',
          paymentIntentId: 'pi_1UnitIntent',
          clientSecret: 'pi_1UnitIntent_secret_AbCdEf123',
        },
      });
    });

    it('treats a bank refusal (402) as a declined card and returns the PaymentIntent to cancel', async () => {
      const { fetchFn } = fake(402, {
        error: {
          type: 'card_error',
          code: 'card_declined',
          payment_intent: { id: 'pi_1Declined' },
        },
      });

      const paid = await new StripeCheckoutGateway(KEY, PMC, fetchFn).payByCard(REQUEST);

      expect(paid).toEqual({
        ok: false,
        error: { code: 'payment.card-declined', paymentIntentId: 'pi_1Declined' },
      });
    });

    it('treats a PaymentIntent that fell back to requires_payment_method as declined', async () => {
      const { fetchFn } = fake(
        200,
        intent({ status: 'requires_payment_method', amount_capturable: 0 }),
      );

      const paid = await new StripeCheckoutGateway(KEY, PMC, fetchFn).payByCard(REQUEST);

      expect(paid).toEqual({
        ok: false,
        error: { code: 'payment.card-declined', paymentIntentId: 'pi_1UnitIntent' },
      });
    });

    it.each([
      ['a live-mode PaymentIntent', intent({ livemode: true })],
      ['another amount than asked for', intent({ amount: 1, amount_capturable: 1 })],
      ['another currency', intent({ currency: 'usd' })],
      ['another order in the metadata', intent({ metadata: { order_id: 'x', market_id: 'AU' } })],
      ['a hold that is not the full amount', intent({ amount_capturable: 100 })],
      ['a PaymentIntent that was already captured', intent({ status: 'succeeded' })],
      [
        'a requires_action without a usable secret',
        intent({ status: 'requires_action', client_secret: 'nope' }),
      ],
      ['an object that is not a PaymentIntent', { object: 'charge' }],
    ])('does not trust %s', async (_name, body) => {
      const paid = await new StripeCheckoutGateway(KEY, PMC, fake(200, body).fetchFn).payByCard(
        REQUEST,
      );

      expect(paid.ok).toBe(false);
    });

    it('maps other 4xx to rejected and 5xx, 429, 409 and a network failure to unavailable', async () => {
      expect(
        await new StripeCheckoutGateway(KEY, PMC, fake(400).fetchFn).payByCard(REQUEST),
      ).toEqual({
        ok: false,
        error: { code: 'payment.provider-rejected' },
      });
      for (const status of [500, 503, 429, 409]) {
        expect(
          await new StripeCheckoutGateway(KEY, PMC, fake(status).fetchFn).payByCard(REQUEST),
        ).toEqual({
          ok: false,
          error: { code: 'payment.provider-unavailable' },
        });
      }
      const down: StripeFetch = () => Promise.reject(new Error('socket hang up'));
      expect(await new StripeCheckoutGateway(KEY, PMC, down).payByCard(REQUEST)).toEqual({
        ok: false,
        error: { code: 'payment.provider-unavailable' },
      });
    });

    it('fails closed without the card-only configuration, with a live key and for a bad token', async () => {
      const { calls, fetchFn } = fake(200, intent());

      expect(await new StripeCheckoutGateway(KEY, null, fetchFn).payByCard(REQUEST)).toEqual({
        ok: false,
        error: { code: 'payment.provider-unavailable' },
      });
      expect(await new StripeCheckoutGateway(KEY, '', fetchFn).payByCard(REQUEST)).toEqual({
        ok: false,
        error: { code: 'payment.provider-unavailable' },
      });
      expect(
        (await new StripeCheckoutGateway('sk_live_x1234567890', PMC, fetchFn).payByCard(REQUEST))
          .ok,
      ).toBe(false);
      expect((await new StripeCheckoutGateway(null, PMC, fetchFn).payByCard(REQUEST)).ok).toBe(
        false,
      );
      expect(
        (
          await new StripeCheckoutGateway(KEY, PMC, fetchFn).payByCard({
            ...REQUEST,
            confirmationToken: 'pm_123',
          })
        ).ok,
      ).toBe(false);
      expect(
        (await new StripeCheckoutGateway(KEY, PMC, fetchFn).payByCard({ ...REQUEST, amount: 0n }))
          .ok,
      ).toBe(false);
      expect(calls).toEqual([]);
    });

    it('never puts the key, the token or the client secret in the failure it returns', async () => {
      const paid = await new StripeCheckoutGateway(
        KEY,
        PMC,
        fake(400, { error: { message: `bad ${KEY} ${TOKEN}` } }).fetchFn,
      ).payByCard(REQUEST);

      const text = JSON.stringify(paid);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
    });
  });
});
