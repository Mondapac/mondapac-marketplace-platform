import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type {
  CheckoutSessionSnapshot,
  PaymentIntentSnapshot,
  ReadFailure,
  StripeSessionReader,
} from '../application/ports/stripe-session-reader';

/** How long one Stripe call may take before it counts as failed. */
export const STRIPE_READ_TIMEOUT_MS = 10_000;
const STRIPE_API = 'https://api.stripe.com';
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,200}$/;
const INTENT_ID = /^pi_[A-Za-z0-9_]{1,200}$/;

/** `fetch`, narrowed to what the reader uses, so tests can pass a fake. */
export type StripeGet = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const UNAVAILABLE: ReadFailure = Object.freeze({ code: 'payment.provider-unavailable' as const });
const REJECTED: ReadFailure = Object.freeze({ code: 'payment.provider-rejected' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const minor = (value: unknown): bigint | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;

/**
 * Reads a Checkout session, with its PaymentIntent expanded, over Stripe's REST API with `fetch`
 * (no SDK). One request, never retried here. Only the fields payments needs are kept; card
 * details are never read. The secret key and Stripe's answer bodies never reach a log or an
 * error: a failure is a code only.
 */
export class StripeCheckoutSessionReader implements StripeSessionReader {
  constructor(
    private readonly secretKey: string | null,
    private readonly fetchFn: StripeGet = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = STRIPE_READ_TIMEOUT_MS,
  ) {}

  async readCheckoutSession(sessionId: string) {
    if (!SESSION_ID.test(sessionId)) return err(REJECTED);
    const body = await this.get(`/v1/checkout/sessions/${sessionId}?expand[]=payment_intent`);
    if (!body.ok) return body;
    const snapshot = toSnapshot(body.value);
    return snapshot === null ? err(UNAVAILABLE) : ok(snapshot);
  }

  async readPaymentIntent(intentId: string) {
    if (!INTENT_ID.test(intentId)) return err(REJECTED);
    const body = await this.get(`/v1/payment_intents/${intentId}?expand[]=payment_method`);
    if (!body.ok) return body;
    const snapshot = toIntentSnapshot(body.value);
    return snapshot === null ? err(UNAVAILABLE) : ok(snapshot);
  }

  private async get(path: string): Promise<Result<unknown, ReadFailure>> {
    if (this.secretKey === null) return err(UNAVAILABLE);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    let body: unknown;
    try {
      const response = await this.fetchFn(`${STRIPE_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: timeout.signal,
      });
      if (response.status >= 500 || response.status === 429) return err(UNAVAILABLE);
      if (response.status >= 400) return err(REJECTED);
      body = await response.json();
    } catch {
      return err(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
    return ok(body);
  }
}

/** Stripe's PaymentIntent, narrowed; null when it is not a well-formed PaymentIntent. */
function toIntentSnapshot(body: unknown): PaymentIntentSnapshot | null {
  if (
    !isObject(body) ||
    body.object !== 'payment_intent' ||
    typeof body.id !== 'string' ||
    !INTENT_ID.test(body.id) ||
    typeof body.livemode !== 'boolean' ||
    typeof body.status !== 'string' ||
    typeof body.currency !== 'string'
  ) {
    return null;
  }
  const amountCapturable = minor(body.amount_capturable);
  if (amountCapturable === null) return null;
  const metadata = isObject(body.metadata) ? body.metadata : {};
  const method = body.payment_method;
  return {
    id: body.id,
    livemode: body.livemode,
    status: body.status,
    currency: body.currency,
    amountCapturable,
    metadataOrderId: text(metadata.order_id),
    metadataMarketId: text(metadata.market_id),
    metadataPaymentFlow: text(metadata.payment_flow),
    paymentMethodType: isObject(method) ? text(method.type) : null,
    cardBrand: isObject(method) && isObject(method.card) ? text(method.card.brand) : null,
  };
}

/** Stripe's session object, narrowed; null when it is not a well-formed session. */
function toSnapshot(body: unknown): CheckoutSessionSnapshot | null {
  if (
    !isObject(body) ||
    body.object !== 'checkout.session' ||
    typeof body.id !== 'string' ||
    typeof body.livemode !== 'boolean' ||
    typeof body.status !== 'string' ||
    typeof body.payment_status !== 'string'
  ) {
    return null;
  }
  const metadata = isObject(body.metadata) ? body.metadata : {};
  let paymentIntent: CheckoutSessionSnapshot['paymentIntent'] = null;
  if (body.payment_intent !== null && body.payment_intent !== undefined) {
    const intent = body.payment_intent;
    if (!isObject(intent)) return null;
    const amountCapturable = minor(intent.amount_capturable);
    const amountReceived = minor(intent.amount_received);
    if (
      typeof intent.id !== 'string' ||
      !INTENT_ID.test(intent.id) ||
      typeof intent.status !== 'string' ||
      typeof intent.currency !== 'string' ||
      amountCapturable === null ||
      amountReceived === null
    ) {
      return null;
    }
    paymentIntent = {
      id: intent.id,
      status: intent.status,
      currency: intent.currency,
      amountCapturable,
      amountReceived,
    };
  }
  return {
    id: body.id,
    livemode: body.livemode,
    status: body.status,
    paymentStatus: body.payment_status,
    clientReferenceId: text(body.client_reference_id),
    metadataOrderId: text(metadata.order_id),
    metadataMarketId: text(metadata.market_id),
    paymentIntent,
  };
}
