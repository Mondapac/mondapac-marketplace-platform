// The Stripe webhook receiver (Phase 5 package 2) against a real Stripe test-mode event. No public
// URL is needed: the script creates a Checkout session in test mode with this Market's metadata,
// expires it, fetches the checkout.session.expired event Stripe wrote, signs it the way Stripe
// signs a delivery (HMAC-SHA256 over `<t>.<body>`) with the secret the running API was started
// with, and posts it to POST /payments/stripe/webhook/<MARKET>. It then checks that the event is
// stored once, that a second delivery changes nothing, and that a wrong signature is refused.
//
// Needs the API running (APP_ROLE=api) with STRIPE_WEBHOOK_SECRET set to WEBHOOK_SIGNING_SECRET,
// and DATABASE_URL for the read of payments.stripe_events. Prints ids and results only.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... WEBHOOK_SIGNING_SECRET=whsec_... DATABASE_URL=... \
//   node scripts/stripe-test/webhook-round-trip.mjs [API base URL] [Market]
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Report, stripe, stripeError, testKey } from './stripe-test-kit.mjs';

const require = createRequire(path.resolve('apps/api/package.json'));
const { Client } = require('pg');

const base = process.argv[2] ?? 'http://localhost:3000';
const market = process.argv[3] ?? 'AU';
const key = testKey();
const secret = process.env.WEBHOOK_SIGNING_SECRET ?? '';
if (!/^whsec_[A-Za-z0-9+/=_]{8,200}$/.test(secret)) {
  console.error('WEBHOOK_SIGNING_SECRET must be a whsec_ value, the one the API was started with.');
  process.exit(1);
}

const report = new Report(`Stripe webhook round trip (Market ${market}, Stripe test mode)`);
const database = new Client({ connectionString: process.env.DATABASE_URL });
await database.connect();

try {
  const event = await realExpiredEvent();
  if (event !== null) await deliver(event);
} finally {
  await database.end();
  report.finish();
}

/** A Checkout session of this Market, expired at once: Stripe writes the event itself. */
async function realExpiredEvent() {
  const orderId = randomUUID();
  const session = await stripe(key, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    success_url: 'https://example.com/stripe-test/success',
    // No payment_method_types: Stripe now refuses it; the Dashboard decides the payment methods.
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][unit_amount]': '1000',
    'line_items[0][price_data][product_data][name]': 'Webhook round-trip check',
    client_reference_id: orderId,
    'metadata[market_id]': market,
    'metadata[order_id]': orderId,
    'metadata[purpose]': 'webhook-check',
  });
  if (
    !report.check(
      'create a test Checkout session',
      session.status === 200,
      session.status === 200 ? session.body.id : stripeError(session),
    )
  ) {
    return null;
  }
  const sessionId = session.body.id;
  const expired = await stripe(key, 'POST', `/v1/checkout/sessions/${sessionId}/expire`);
  if (
    !report.check(
      'expire it',
      expired.status === 200,
      expired.status === 200 ? expired.body.status : stripeError(expired),
    )
  ) {
    return null;
  }
  // Stripe writes the event within seconds; the list is read until it shows up.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const events = await stripe(key, 'GET', '/v1/events?type=checkout.session.expired&limit=20');
    const found = events.body?.data?.find((item) => item.data?.object?.id === sessionId);
    if (found) {
      report.pass('Stripe wrote checkout.session.expired', found.id);
      return found;
    }
    await sleep(2000);
  }
  report.fail('Stripe wrote checkout.session.expired', `none for ${sessionId} after 60 s`);
  return null;
}

async function deliver(event) {
  const body = JSON.stringify(event);
  const first = await post(body, sign(body, secret));
  report.check(
    'first delivery answers 200',
    first.status === 200,
    `HTTP ${first.status} ${first.code}`,
  );
  const stored = await rows(event.id);
  report.check(
    'the event is stored once',
    stored.length === 1 &&
      stored[0].type === event.type &&
      stored[0].object_id === event.data.object.id,
    `${stored.length} row(s)`,
  );

  const again = await post(body, sign(body, secret));
  report.check(
    'a repeated delivery answers 200',
    again.status === 200,
    `HTTP ${again.status} ${again.code}`,
  );
  report.check('a repeated delivery adds no row', (await rows(event.id)).length === 1);

  const forged = await post(body, sign(body, `whsec_${randomBytes(24).toString('hex')}`));
  report.check(
    'a wrong signature is refused',
    forged.status === 400 && forged.code === 'payments.signature-invalid',
    `HTTP ${forged.status} ${forged.code}`,
  );
}

/** Stripe's scheme: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
function sign(body, signingSecret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', signingSecret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Posts the raw body; the answer's error code only, never anything else of it. */
async function post(body, signature) {
  const response = await fetch(`${base}/payments/stripe/webhook/${market}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const answer = await response.json().catch(() => ({}));
  return { status: response.status, code: answer.code ?? '' };
}

async function rows(eventId) {
  const result = await database.query(
    'SELECT type, object_id FROM payments.stripe_events WHERE market_id = $1 AND event_id = $2',
    [market, eventId],
  );
  return result.rows;
}
