import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { AdminCustomerDisputesExport } from '../src/modules/payments/application/use-cases/admin-customer-disputes-export.use-case';
import { AdminCustomerDisputes } from '../src/modules/payments/application/use-cases/admin-customer-disputes.use-case';
import { AdminCustomerPaymentsExport } from '../src/modules/payments/application/use-cases/admin-customer-payments-export.use-case';
import { AdminCustomerPayments } from '../src/modules/payments/application/use-cases/admin-customer-payments.use-case';
import { PAYMENTS_CUSTOMER_STATUS } from '../src/modules/payments/presentation/admin-customer-payments.controller';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The customer payment and dispute routes (customers management phase 2b, gaps c, d, f) over HTTP:
// the real guards and controller with stubbed use cases. This proves the admin session, CSRF, the
// closed body, the bigint amounts as digits, the refusal statuses, `no-store` and that an export
// without a fresh two-step proof never reaches its use case. The use cases have their own spec.

const START = Temporal.Instant.from('2026-11-16T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const CUSTOMER = id<'Account'>(0xc001);
const ORDER = id<'Order'>(0xd001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the customer payment routes to its exact status', () => {
  expect(PAYMENTS_CUSTOMER_STATUS).toMatchObject({
    'validation.failed': 400,
    'batch.too-large': 413,
    'second-factor.required': 403,
    'access.denied': 403,
    'access.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('customer payments over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(AdminCustomerPayments)
          .useValue(stub('payments'))
          .overrideProvider(AdminCustomerPaymentsExport)
          .useValue(stub('payments-export'))
          .overrideProvider(AdminCustomerDisputes)
          .useValue(stub('disputes'))
          .overrideProvider(AdminCustomerDisputesExport)
          .useValue(stub('disputes-export')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'pay-seed-0002'), {});
    fakes.seedAccount({
      id: ADMIN,
      marketId,
      population: 'admin',
      email: { typed: 'admin@Example.com', normalized: 'admin@example.com' },
      displayName: 'admin',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
  }

  function admin(n: number, csrf = true) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: ADMIN,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      ...(csrf ? { 'x-csrf-token': csrfTokenFor(issued.token) } : {}),
    };
  }
  const BASE = `/payments/admin/customers/${CUSTOMER}`;

  beforeEach(() => {
    fakes.reset();
    calls = [];
  });
  afterEach(async () => {
    await app?.close();
  });

  it('pages the payments with the paid total, amounts as digits and the account from the path', async () => {
    await boot();
    next = ok({
      items: [
        {
          orderId: ORDER,
          status: 'confirmed',
          paymentState: 'captured',
          amount: { amount: 3850n, currency },
          providerPaymentId: 'pi_test_0001',
          createdAt: START,
          confirmedAt: START,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      paging: 'pages',
      hasNext: false,
      paid: [{ amount: 3850n, currency }],
    });

    const res = await http()
      .post(`${BASE}/payments`)
      .set(admin(1))
      .send({ filters: { paymentState: ['captured'] }, sort: 'amount' });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      items: [
        { orderId: ORDER, amount: { amount: '3850', currency }, createdAt: START.toString() },
      ],
      paid: [{ amount: '3850', currency }],
    });
    expect(calls).toEqual([
      {
        name: 'payments',
        input: { filters: { paymentState: ['captured'] }, sort: 'amount', accountId: CUSTOMER },
      },
    ]);
  });

  it('refuses a stray field, a write without CSRF, and maps the refusals of the disputes list', async () => {
    await boot();
    const stray = await http().post(`${BASE}/disputes`).set(admin(2)).send({ accountId: 'x' });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
    });
    expect((await http().post(`${BASE}/disputes`).set(admin(3, false)).send({})).status).toBe(403);
    expect(calls).toEqual([]);

    next = err({ code: 'batch.too-large', max: 10000 });
    const large = await http().post(`${BASE}/disputes`).set(admin(4)).send({});
    expect(large.status).toBe(413);
    expect(large.body).toEqual({
      statusCode: 413,
      code: 'batch.too-large',
      details: { max: 10000 },
    });
    next = err({ code: 'access.denied' });
    expect((await http().post(`${BASE}/disputes`).set(admin(5)).send({})).status).toBe(403);
  });

  it('asks for a fresh two-step proof before either export reaches its use case', async () => {
    await boot();
    for (const path of ['payments/export', 'disputes/export']) {
      const res = await http()
        .post(`${BASE}/${path}`)
        .set(admin(path.length))
        .send({ format: 'csv' });
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toMatch(/^second-factor\./);
    }
    expect(calls).toEqual([]);
  });
});
