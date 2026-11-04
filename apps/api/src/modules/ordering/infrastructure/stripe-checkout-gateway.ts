import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type {
  CheckoutGateway,
  CreateSessionRequest,
  CardPaymentAnswer,
  CardPaymentFailure,
  ConfirmationTokenFacts,
  GatewayFailure,
  PayByCardRequest,
  RefundAnswer,
  RefundCallRequest,
} from '../application/ports/checkout-gateway';

/** How long one Stripe call may take before it counts as failed. */
export const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_API = 'https://api.stripe.com';

/** `fetch`, narrowed to what the adapter uses, so tests can pass a fake. */
export type StripeFetch = (
  url: string,
  init: {
    method: 'POST' | 'GET';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const UNAVAILABLE: GatewayFailure = Object.freeze({
  code: 'payment.provider-unavailable' as const,
});
const REJECTED: GatewayFailure = Object.freeze({ code: 'payment.provider-rejected' as const });
const REFUND_ID = /^re_[A-Za-z0-9_]{1,200}$/;
const CONFIRMATION_TOKEN = /^ctoken_[A-Za-z0-9_]{1,200}$/;
const INTENT_ID = /^pi_[A-Za-z0-9_]{1,200}$/;
const CLIENT_SECRET = /^pi_[A-Za-z0-9_]{1,200}_secret_[A-Za-z0-9_]{1,200}$/;
const CARD_BRAND = /^[a-z_]{1,32}$/;
/** The tag on every PaymentIntent this flow makes; the webhook worker acts on tagged ones only. */
export const CARD_FLOW_TAG = 'card-intent';

/**
 * Stripe's refund object as {@link RefundAnswer}. Only `succeeded` is money back (Hassan M1);
 * `pending` and `requires_action` are read again later; `failed` and `canceled` gave nothing
 * back. Anything else, or no refund id, is not an answer.
 */
function refundAnswer(
  answer: Result<Record<string, unknown>, GatewayFailure>,
): Result<RefundAnswer, GatewayFailure> {
  if (!answer.ok) return answer;
  const { id, status } = answer.value;
  if (typeof id !== 'string' || !REFUND_ID.test(id)) return err(UNAVAILABLE);
  if (status === 'succeeded') return ok({ refundId: id, status: 'succeeded' });
  if (status === 'pending' || status === 'requires_action') {
    return ok({ refundId: id, status: 'pending' });
  }
  if (status === 'failed' || status === 'canceled') return ok({ refundId: id, status: 'failed' });
  return err(UNAVAILABLE);
}

/**
 * Stripe Checkout over its REST API with `fetch` (no SDK). One request per call, never retried
 * here (the equivalent of `maxNetworkRetries: 0`): a caller that retries sends the same
 * idempotency key. Manual capture: the page authorises the card, `capture` takes the money once
 * ordering has committed the stock. Card (with Apple Pay and Google Pay) only; no eftpos: Stripe
 * no longer takes `payment_method_types` on a session, so the session names a payment method
 * configuration that allows only those, and without one no session is opened.
 *
 * The secret key, the client secret and Stripe's answer bodies never reach a log or an error: a
 * failure is a code only.
 */
/** A Stripe payment method configuration id; the same shape app-config accepts. */
const PAYMENT_METHOD_CONFIGURATION = /^pmc_[A-Za-z0-9]{8,64}$/;

export class StripeCheckoutGateway implements CheckoutGateway {
  constructor(
    private readonly secretKey: string | null,
    private readonly paymentMethodConfiguration: string | null,
    private readonly fetchFn: StripeFetch = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = STRIPE_TIMEOUT_MS,
  ) {}

  async createSession(request: CreateSessionRequest) {
    // Fail closed: a session without the card-only configuration would offer every payment
    // method the account has switched on. Anything but a pmc_ id (an empty value from a script)
    // counts as unset, because Stripe would fall back to the account's default configuration.
    if (!PAYMENT_METHOD_CONFIGURATION.test(this.paymentMethodConfiguration ?? '')) {
      return err(UNAVAILABLE);
    }
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('client_reference_id', request.orderId);
    form.set('success_url', request.successUrl);
    form.set('cancel_url', request.cancelUrl);
    form.set('expires_at', String(Math.floor(request.expiresAt.epochMilliseconds / 1000)));
    form.set('payment_method_configuration', this.paymentMethodConfiguration as string);
    form.set('payment_intent_data[capture_method]', 'manual');
    form.set('payment_intent_data[metadata][order_id]', request.orderId);
    form.set('payment_intent_data[metadata][market_id]', request.marketId);
    form.set('metadata[order_id]', request.orderId);
    form.set('metadata[market_id]', request.marketId);
    request.packages.forEach((item, index) => {
      form.set(`line_items[${index}][quantity]`, '1');
      form.set(`line_items[${index}][price_data][currency]`, request.currency.toLowerCase());
      form.set(`line_items[${index}][price_data][unit_amount]`, item.amount.toString());
      form.set(`line_items[${index}][price_data][product_data][name]`, item.label);
    });
    const answer = await this.post('/v1/checkout/sessions', form, request.idempotencyKey);
    if (!answer.ok) return answer;
    const body = answer.value;
    if (
      typeof body.id !== 'string' ||
      typeof body.url !== 'string' ||
      !body.url.startsWith('https://')
    ) {
      return err(UNAVAILABLE);
    }
    return ok({ sessionId: body.id, url: body.url });
  }

  async expireSession(sessionId: string): Promise<void> {
    if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return;
    await this.post(`/v1/checkout/sessions/${sessionId}/expire`, new URLSearchParams(), null);
  }

  async capture(paymentIntentId: string, idempotencyKey: string) {
    return this.intentCall(paymentIntentId, 'capture', idempotencyKey);
  }

  async voidAuthorisation(paymentIntentId: string, idempotencyKey: string) {
    return this.intentCall(paymentIntentId, 'cancel', idempotencyKey);
  }

  /**
   * `POST /v1/refunds` for part of the captured PaymentIntent. Refused here, without a call, unless
   * the key is a test-mode key (`sk_test_`): no real money moves until the tax agent has confirmed
   * in writing and the owner decides to go live (tax step 3).
   */
  async refund(request: RefundCallRequest) {
    if (this.secretKey === null || !this.secretKey.startsWith('sk_test_')) return err(REJECTED);
    if (!/^pi_[A-Za-z0-9_]{1,200}$/.test(request.paymentIntentId) || request.amount <= 0n) {
      return err(REJECTED);
    }
    const form = new URLSearchParams();
    form.set('payment_intent', request.paymentIntentId);
    form.set('amount', request.amount.toString());
    form.set('metadata[order_id]', request.orderId);
    form.set('metadata[refund_id]', request.refundId);
    form.set('metadata[market_id]', request.marketId);
    return refundAnswer(await this.post('/v1/refunds', form, request.idempotencyKey));
  }

  /**
   * Never `rejected` (Hassan M1-R): Stripe already made this refund, so a refusal here (a live or
   * rotated key, a 401 or 404) says nothing about the money and must keep the refund pending.
   */
  async refundStatus(stripeRefundId: string) {
    if (this.secretKey === null || !this.secretKey.startsWith('sk_test_')) return err(UNAVAILABLE);
    if (!REFUND_ID.test(stripeRefundId)) return err(UNAVAILABLE);
    const read = await this.post(`/v1/refunds/${stripeRefundId}`, null, null);
    const answer = read.ok ? read : err(UNAVAILABLE);
    // Another refund than the one asked for is not an answer.
    if (answer.ok && answer.value.id !== stripeRefundId) return err(UNAVAILABLE);
    return refundAnswer(answer);
  }

  /**
   * `GET /v1/confirmation_tokens/<id>`: the brand of the card the buyer's browser tokenised.
   * Refused (no call) unless the key is a test-mode key; a live-mode token is refused too.
   */
  async readConfirmationToken(
    confirmationToken: string,
  ): Promise<Result<ConfirmationTokenFacts, GatewayFailure>> {
    if (this.secretKey === null || !this.secretKey.startsWith('sk_test_')) return err(REJECTED);
    if (!CONFIRMATION_TOKEN.test(confirmationToken)) return err(REJECTED);
    const read = await this.post(`/v1/confirmation_tokens/${confirmationToken}`, null, null);
    if (!read.ok) return read;
    const body = read.value;
    const preview = body.payment_method_preview;
    if (
      body.object !== 'confirmation_token' ||
      body.id !== confirmationToken ||
      typeof body.livemode !== 'boolean' ||
      typeof preview !== 'object' ||
      preview === null
    ) {
      return err(UNAVAILABLE);
    }
    if (body.livemode) return err(REJECTED);
    const { type, card } = preview as { type?: unknown; card?: unknown };
    const brand =
      typeof card === 'object' && card !== null ? (card as { brand?: unknown }).brand : undefined;
    return ok({
      livemode: false,
      methodType: typeof type === 'string' ? type : '',
      cardBrand: typeof brand === 'string' && CARD_BRAND.test(brand) ? brand : null,
    });
  }

  /**
   * `POST /v1/payment_intents` with `confirm=true`: manual capture, the order's own amount, cards
   * only through the same payment method configuration as the hosted page. One request, never
   * retried here; the order's key makes a repeat return the same PaymentIntent. A 402 is a card
   * the bank refused; its PaymentIntent id (if Stripe made one) is returned so ordering can cancel
   * it. No card data, token or client secret reaches a log.
   */
  async payByCard(
    request: PayByCardRequest,
  ): Promise<Result<CardPaymentAnswer, CardPaymentFailure>> {
    if (this.secretKey === null || !this.secretKey.startsWith('sk_test_')) return err(REJECTED);
    if (!PAYMENT_METHOD_CONFIGURATION.test(this.paymentMethodConfiguration ?? '')) {
      return err(UNAVAILABLE);
    }
    if (!CONFIRMATION_TOKEN.test(request.confirmationToken) || request.amount <= 0n) {
      return err(REJECTED);
    }
    const form = new URLSearchParams();
    form.set('amount', request.amount.toString());
    form.set('currency', request.currency.toLowerCase());
    form.set('capture_method', 'manual');
    form.set('confirm', 'true');
    form.set('confirmation_token', request.confirmationToken);
    form.set('payment_method_configuration', this.paymentMethodConfiguration as string);
    form.set('automatic_payment_methods[enabled]', 'true');
    form.set('return_url', request.returnUrl);
    form.set('metadata[order_id]', request.orderId);
    form.set('metadata[market_id]', request.marketId);
    form.set('metadata[payment_flow]', CARD_FLOW_TAG);
    const sent = await this.send('/v1/payment_intents', form, request.idempotencyKey);
    if (!sent.ok) return sent;
    const { status, body } = sent.value;
    if (status === 402) {
      const intent = (body?.error as { payment_intent?: { id?: unknown } } | undefined)
        ?.payment_intent;
      const id = typeof intent?.id === 'string' && INTENT_ID.test(intent.id) ? intent.id : null;
      return err({ code: 'payment.card-declined', paymentIntentId: id });
    }
    if (status >= 400) return err(REJECTED);
    if (
      body === null ||
      body.object !== 'payment_intent' ||
      typeof body.id !== 'string' ||
      !INTENT_ID.test(body.id) ||
      body.livemode !== false ||
      body.currency !== request.currency.toLowerCase() ||
      body.amount !== Number(request.amount)
    ) {
      return err(UNAVAILABLE);
    }
    const metadata = body.metadata as Record<string, unknown> | null;
    if (metadata?.order_id !== request.orderId) return err(UNAVAILABLE);
    switch (body.status) {
      case 'requires_capture':
        return body.amount_capturable === body.amount
          ? ok({ status: 'authorised', paymentIntentId: body.id })
          : err(UNAVAILABLE);
      case 'requires_action':
        return typeof body.client_secret === 'string' && CLIENT_SECRET.test(body.client_secret)
          ? ok({
              status: 'requires-action',
              paymentIntentId: body.id,
              clientSecret: body.client_secret,
            })
          : err(UNAVAILABLE);
      case 'requires_payment_method':
        return err({ code: 'payment.card-declined', paymentIntentId: body.id });
      default:
        // processing, succeeded (automatic capture) and anything new: not what a manual hold is.
        return err({ code: 'payment.provider-unavailable' });
    }
  }

  private async intentCall(
    paymentIntentId: string,
    action: 'capture' | 'cancel',
    idempotencyKey: string,
  ): Promise<Result<true, GatewayFailure>> {
    if (!/^pi_[A-Za-z0-9_]{1,200}$/.test(paymentIntentId)) return err(REJECTED);
    const answer = await this.post(
      `/v1/payment_intents/${paymentIntentId}/${action}`,
      new URLSearchParams(),
      idempotencyKey,
    );
    return answer.ok ? ok(true as const) : answer;
  }

  /**
   * One POST, or a GET without a form. 5xx, a timeout and a network error are `unavailable`; a
   * 4xx is `rejected`.
   */
  private async post(
    path: string,
    form: URLSearchParams | null,
    idempotencyKey: string | null,
  ): Promise<Result<Record<string, unknown>, GatewayFailure>> {
    const sent = await this.send(path, form, idempotencyKey);
    if (!sent.ok) return sent;
    if (sent.value.status >= 400) return err(REJECTED);
    return sent.value.body === null ? err(UNAVAILABLE) : ok(sent.value.body);
  }

  /** The request itself: the status of a 4xx answer and its body are returned for the caller. */
  private async send(
    path: string,
    form: URLSearchParams | null,
    idempotencyKey: string | null,
  ): Promise<Result<{ status: number; body: Record<string, unknown> | null }, GatewayFailure>> {
    if (this.secretKey === null) return err(UNAVAILABLE);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${STRIPE_API}${path}`, {
        method: form === null ? 'GET' : 'POST',
        headers,
        ...(form === null ? {} : { body: form.toString() }),
        signal: timeout.signal,
      });
      if (response.status >= 500 || response.status === 429 || response.status === 409) {
        return err(UNAVAILABLE);
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const object =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      if (response.status < 400 && object === null) return err(UNAVAILABLE);
      return ok({ status: response.status, body: object });
    } catch {
      return err(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }
}
