import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { STRIPE_EVENT_INBOX } from '../src/modules/payments/application/ports/stripe-event-inbox';
import { WEBHOOK_STATUS } from '../src/modules/payments/presentation/stripe-webhook.controller';
import { CLOCK } from '../src/platform/clock/clock.module';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import {
  checkoutEvent,
  MemoryInbox,
  stripeSignatureHeader,
  TEST_WEBHOOK_SECRET,
} from './support/payments-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The Stripe webhook route over HTTP: the real guards, raw-body parser, controller, gate and use
// case; the inbox is in memory. Proves the Market comes from the path (Stripe sends no
// x-market-id), the signature is checked over the exact bytes, no session or Origin is needed,
// every refusal has its status, and the answer never echoes the event.

const codeOf = (res: request.Response) => (res.body as { code?: string }).code;
const START = Temporal.Instant.from('2026-10-14T10:00:00Z');

it('maps every refusal code of the webhook to its exact status', () => {
  expect(WEBHOOK_STATUS).toEqual({
    'validation.failed': 400,
    'payments.signature-invalid': 400,
    'payments.event-refused': 400,
    'payments.webhook-unavailable': 503,
    'access.unauthenticated': 401,
    'access.denied': 403,
    'access.seller-not-approved': 403,
    'access.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('Stripe webhook over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let inbox: MemoryInbox;
  const clock = new FixedClock(START);
  const other = TEST_MARKETS.find((m) => m !== code)!;

  const start = async (
    env: Record<string, string> = { STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET },
  ) => {
    inbox = new MemoryInbox();
    ({ app } = await createTestApp({
      env,
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(STRIPE_EVENT_INBOX)
          .useValue(inbox),
    }));
  };
  afterEach(async () => {
    await app?.close();
  });

  // Indented JSON: re-serialising a parsed body would change these bytes and break the signature.
  const bodyOf = (event: Record<string, unknown>) => JSON.stringify(event, null, 2);
  const post = (path: string, body: string, signature?: string, type = 'application/json') => {
    const req = request(app.getHttpServer())
      .post(path)
      .set('Content-Type', type)
      .set('User-Agent', 'Stripe/1.0 (+https://stripe.com/docs/webhooks)');
    return (signature === undefined ? req : req.set('Stripe-Signature', signature)).send(body);
  };

  it('stores a signed event without a session, an Origin or x-market-id, and a repeat once', async () => {
    await start();
    const body = bodyOf(checkoutEvent({ marketId: code }));
    const signature = stripeSignatureHeader(body, START);

    const first = await post(`/payments/stripe/webhook/${code}`, body, signature);
    const again = await post(`/payments/stripe/webhook/${code}`, body, signature);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    expect(first.headers['cache-control']).toBe('no-store');
    expect(again.status).toBe(200);
    expect(inbox.rows.size).toBe(1);
    expect(inbox.get(code, 'evt_test_0001')?.objectId).toBe('cs_test_0001');
  });

  it('refuses a body whose bytes differ from what was signed', async () => {
    await start();
    const body = bodyOf(checkoutEvent({ marketId: code }));
    const signature = stripeSignatureHeader(JSON.stringify(JSON.parse(body)), START);

    const res = await post(`/payments/stripe/webhook/${code}`, body, signature);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ statusCode: 400, code: 'payments.signature-invalid' });
    expect(inbox.rows.size).toBe(0);
  });

  it('refuses a missing signature, an event of another Market and a Market not hosted', async () => {
    await start();
    const own = bodyOf(checkoutEvent({ marketId: code }));
    const foreign = bodyOf(checkoutEvent({ marketId: other }));

    const unsigned = await post(`/payments/stripe/webhook/${code}`, own);
    const crossed = await post(
      `/payments/stripe/webhook/${code}`,
      foreign,
      stripeSignatureHeader(foreign, START),
    );
    const unhosted = await post(
      '/payments/stripe/webhook/QQ',
      own,
      stripeSignatureHeader(own, START),
    );
    const invalid = await post(
      '/payments/stripe/webhook/au',
      own,
      stripeSignatureHeader(own, START),
    );

    expect([unsigned.status, codeOf(unsigned)]).toEqual([400, 'payments.signature-invalid']);
    expect([crossed.status, codeOf(crossed)]).toEqual([400, 'payments.event-refused']);
    expect([unhosted.status, codeOf(unhosted)]).toEqual([400, 'market.not-hosted']);
    expect([invalid.status, codeOf(invalid)]).toEqual([400, 'market.header-invalid']);
    expect(inbox.rows.size).toBe(0);
  });

  it('refuses a body that is not JSON', async () => {
    await start();
    const body = bodyOf(checkoutEvent({ marketId: code }));

    const res = await post(
      `/payments/stripe/webhook/${code}`,
      body,
      stripeSignatureHeader(body, START),
      'text/plain',
    );

    expect(res.status).toBe(415);
    expect(codeOf(res)).toBe('request.body-unsupported');
  });

  it('answers 503 without a signing secret, so Stripe retries', async () => {
    await start({});
    const body = bodyOf(checkoutEvent({ marketId: code }));

    const res = await post(
      `/payments/stripe/webhook/${code}`,
      body,
      stripeSignatureHeader(body, START),
    );

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ statusCode: 503, code: 'payments.webhook-unavailable' });
  });

  it('leaves the JSON parser of every other route as it was', async () => {
    await start();

    const res = await request(app.getHttpServer())
      .post('/cart/items')
      .set('x-market-id', code)
      .set('Content-Type', 'application/json')
      .send('{"broken"');

    expect(res.status).toBe(400);
  });
});
