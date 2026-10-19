import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type {
  CheckoutGateway,
  CreateSessionRequest,
  GatewayFailure,
  RefundCallRequest,
} from '../application/ports/checkout-gateway';

/** How long one Stripe call may take before it counts as failed. */
export const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_API = 'https://api.stripe.com';

/** `fetch`, narrowed to what the adapter uses, so tests can pass a fake. */
export type StripeFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const UNAVAILABLE: GatewayFailure = Object.freeze({
  code: 'payment.provider-unavailable' as const,
});
const REJECTED: GatewayFailure = Object.freeze({ code: 'payment.provider-rejected' as const });

/**
 * Stripe Checkout over its REST API with `fetch` (no SDK). One request per call, never retried
 * here (the equivalent of `maxNetworkRetries: 0`): a caller that retries sends the same
 * idempotency key. Manual capture: the page authorises the card, `capture` takes the money once
 * ordering has committed the stock. Card (with Apple Pay and Google Pay) only; no eftpos.
 *
 * The secret key, the client secret and Stripe's answer bodies never reach a log or an error: a
 * failure is a code only.
 */
export class StripeCheckoutGateway implements CheckoutGateway {
  constructor(
    private readonly secretKey: string | null,
    private readonly fetchFn: StripeFetch = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = STRIPE_TIMEOUT_MS,
  ) {}

  async createSession(request: CreateSessionRequest) {
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('client_reference_id', request.orderId);
    form.set('success_url', request.successUrl);
    form.set('cancel_url', request.cancelUrl);
    form.set('expires_at', String(Math.floor(request.expiresAt.epochMilliseconds / 1000)));
    form.set('payment_method_types[0]', 'card');
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
    const answer = await this.post('/v1/refunds', form, request.idempotencyKey);
    if (!answer.ok) return answer;
    const id = answer.value.id;
    const status = answer.value.status;
    if (typeof id !== 'string' || !/^re_[A-Za-z0-9_]{1,200}$/.test(id)) return err(UNAVAILABLE);
    // A refund Stripe already marked failed or canceled gave nothing back.
    if (status === 'failed' || status === 'canceled') return err(REJECTED);
    return ok({ refundId: id });
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

  /** One POST. 5xx, a timeout and a network error are `unavailable`; a 4xx is `rejected`. */
  private async post(
    path: string,
    form: URLSearchParams,
    idempotencyKey: string | null,
  ): Promise<Result<Record<string, unknown>, GatewayFailure>> {
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
        method: 'POST',
        headers,
        body: form.toString(),
        signal: timeout.signal,
      });
      if (response.status >= 500 || response.status === 429 || response.status === 409) {
        return err(UNAVAILABLE);
      }
      if (response.status >= 400) return err(REJECTED);
      const body = await response.json();
      return typeof body === 'object' && body !== null
        ? ok(body as Record<string, unknown>)
        : err(UNAVAILABLE);
    } catch {
      return err(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }
}
