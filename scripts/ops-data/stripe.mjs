// Stripe test mode for the orders pack (operational test data design, phase 2, PR 3): the buyer's
// browser tokenises a card with the Payment Element; here Stripe's test helper makes that
// ConfirmationToken from a test payment method (pm_card_*), so no card number is ever handled.
//
// Stripe cannot reach a local API, so the loader also stands in for Stripe's webhook delivery: it
// reads the real test-mode events of a PaymentIntent from Stripe (GET /v1/events) and posts each
// one, unchanged, to the local webhook route, signed with the local STRIPE_WEBHOOK_SECRET exactly
// as Stripe signs (`t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`). The API never trusts the body
// anyway: it reads the PaymentIntent again from Stripe and acts only on what Stripe says now.
//
// Guards: the key must be a test-mode key (guard 4, checked again here), every Stripe answer must
// say livemode false, only the events of a PaymentIntent the loader itself just created are sent,
// and only to the local API (guard 2 holds for its URL). The key and the secret are never printed.
import crypto from 'node:crypto';
import { assertStripeTestKey } from './guard.mjs';
import { API, sleep } from './lib.mjs';

const STRIPE = 'https://api.stripe.com';
const PAYMENT_INTENT = /^pi_[A-Za-z0-9]{1,100}$/;
/** At most this many pages of 100 events per type and attempt. */
const MAX_EVENT_PAGES = 10;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{8,200}$/;

/** The card PaymentIntent events the API keeps (payments' CARD_PAYMENT_EVENT_TYPES). */
export const CARD_EVENT_TYPES = [
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
];

/**
 * The webhook signing secret of a Market from STRIPE_WEBHOOK_SECRET, in the API's format: a bare
 * whsec_ for every Market, or `AU=whsec_...,NZ=whsec_...`. Throws when there is none.
 */
export function webhookSecretOf(value, market) {
  const text = (value ?? '').trim();
  let secret;
  if (WEBHOOK_SECRET.test(text)) secret = text;
  else {
    for (const pair of text.split(',')) {
      const [code, entry] = pair.split('=', 2).map((part) => part?.trim());
      if (code === market) secret = entry;
    }
  }
  if (secret === undefined || !WEBHOOK_SECRET.test(secret)) {
    throw new Error(
      `STRIPE_WEBHOOK_SECRET has no signing secret for Market ${market}: the orders pack signs the ` +
        'replayed Stripe events with it, so set the same value the API reads (.env).',
    );
  }
  return secret;
}

/** The Stripe-Signature header value Stripe would send for this body at this time. */
export function signatureFor(secret, body, at = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${at}.${body}`, 'utf8').digest('hex');
  return `t=${at},v1=${v1}`;
}

export class StripeTestMode {
  #key;

  constructor(key, market) {
    if (key === undefined || key === '') {
      throw new Error(
        'STRIPE_SECRET_KEY is not set: the orders pack pays with Stripe test cards (see README.md).',
      );
    }
    assertStripeTestKey(key);
    this.#key = key;
    this.market = market;
  }

  async #call(method, path, form) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(STRIPE + path, {
        method,
        headers: {
          authorization: `Bearer ${this.#key}`,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
      const body = await response.json().catch(() => null);
      if (response.status === 429 && attempt < 4) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        // Stripe's error type and code only: never the request, the key or the whole answer.
        throw new Error(
          `Stripe ${method} ${path.split('?', 1)[0]} -> ${response.status} ` +
            `${body?.error?.type ?? ''} ${body?.error?.code ?? ''}`.trim(),
        );
      }
      return body;
    }
  }

  /** A ConfirmationToken for a Stripe test payment method (pm_card_*), as a browser would make. */
  async confirmationToken(paymentMethod) {
    if (!/^pm_card_[a-zA-Z0-9]{1,60}$/.test(paymentMethod)) {
      throw new Error(`not a Stripe test payment method: ${paymentMethod}`);
    }
    const token = await this.#call('POST', '/v1/test_helpers/confirmation_tokens', {
      payment_method: paymentMethod,
    });
    if (token?.object !== 'confirmation_token' || token.livemode !== false) {
      throw new Error('Stripe answered a confirmation token that is not a test-mode one');
    }
    return token.id;
  }

  /**
   * The card events of one PaymentIntent the loader made, oldest first. Stripe writes an event a
   * moment after the change, so this waits up to `seconds` for at least one of `types`.
   */
  async eventsOf(paymentIntentId, since, { types = CARD_EVENT_TYPES, seconds = 60 } = {}) {
    if (!PAYMENT_INTENT.test(paymentIntentId)) throw new Error('not a PaymentIntent id');
    if (!Number.isSafeInteger(since) || since < 0) throw new Error('not a time in seconds');
    for (let waited = 0; ; waited += 2) {
      const found = [];
      for (const type of types) {
        // Every page: a shared test account can have more than 100 events since the order.
        let after = '';
        for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
          const list = await this.#call(
            'GET',
            `/v1/events?type=${encodeURIComponent(type)}&created[gte]=${since}&limit=100${after}`,
          );
          for (const event of list.data ?? []) {
            if (event.livemode !== false) throw new Error('Stripe listed a live-mode event');
            if (event.data?.object?.id === paymentIntentId && !event.account) found.push(event);
          }
          const last = list.data?.at(-1)?.id;
          if (!list.has_more || typeof last !== 'string') break;
          after = `&starting_after=${encodeURIComponent(last)}`;
        }
      }
      if (found.length > 0 || waited >= seconds) {
        return found.sort((a, b) => a.created - b.created);
      }
      await sleep(2000);
    }
  }

  /**
   * The PaymentIntent of a local order, read from Stripe: it must be a test-mode one that the
   * checkout made for this order (metadata), or the loader replays nothing for it.
   */
  async assertOwnPaymentIntent(paymentIntentId, orderId) {
    if (!PAYMENT_INTENT.test(paymentIntentId)) throw new Error('not a PaymentIntent id');
    const intent = await this.#call('GET', `/v1/payment_intents/${paymentIntentId}`);
    if (intent?.id !== paymentIntentId || intent.livemode !== false) {
      throw new Error('Stripe answered a PaymentIntent that is not this test-mode one');
    }
    const meta = intent.metadata ?? {};
    if (
      meta.order_id !== orderId ||
      meta.market_id !== this.market ||
      meta.payment_flow !== 'card-intent'
    ) {
      throw new Error(`the PaymentIntent was not made for order ${orderId}; nothing is replayed`);
    }
  }
}

/**
 * Posts one Stripe event to the local webhook route of the Market, signed as Stripe signs it.
 * Returns the HTTP status; 2xx means the API stored it (the worker applies it).
 */
export async function deliverEvent(event, secret, market) {
  const body = JSON.stringify(event);
  const response = await fetch(`${API}/payments/stripe/webhook/${market}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signatureFor(secret, body),
    },
    body,
  });
  await response.text();
  return response.status;
}
