import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { DecideDispute } from '../src/modules/commission-payouts/application/use-cases/decide-dispute.use-case';
import { ListDisputes } from '../src/modules/commission-payouts/application/use-cases/list-disputes.use-case';
import { ListOwnDisputes } from '../src/modules/commission-payouts/application/use-cases/list-own-disputes.use-case';
import { ViewDispute } from '../src/modules/commission-payouts/application/use-cases/view-dispute.use-case';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { AUTHENTICATOR, type Authenticator } from '../src/platform/authz/authenticator';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The dispute routes (package 8b) over HTTP: the real guards and controllers; the use cases are
// stubs, so this proves the session, the panel population, CSRF, the closed body, the step-up
// guard, the refusal of an acting-as session, the status of each refusal and the answer shape
// (money as strings, instants as text, `no-store`). The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const SELLER = id<'Seller'>(0xb020);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const DISPUTE = id<'Dispute'>(0xd001);
const SELLER_ORDER = id<'SellerOrder'>(0xc020);
const ORDER = id<'Order'>(0xc021);
const ACTION = 'commission-payouts.dispute.attribute';

describe.each(TEST_MARKETS)('disputes over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
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
          .useValue(clock)
          .overrideProvider(ListDisputes)
          .useValue(stub('list-disputes'))
          .overrideProvider(ViewDispute)
          .useValue(stub('view-dispute'))
          .overrideProvider(DecideDispute)
          .useValue(stub('decide-dispute'))
          .overrideProvider(ListOwnDisputes)
          .useValue(stub('own-disputes')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'cp-seed-0001'), {});
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    for (const [accountId, population, label] of [
      [OWNER, 'seller', 'owner'],
      [ADMIN, 'admin', 'admin'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: label,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    }
    fakes.factors.set(ADMIN, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: ADMIN,
      state: 'active',
      secretCiphertext: 'sealed',
      pendingSecretCiphertext: null,
      lastAcceptedStep: null,
      activatedAt: START,
      lockedAt: null,
      createdAt: START,
      recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
        position: index + 1,
        codeHash: new Uint8Array(32).fill(index + 1),
        usedAt: null,
      })),
      version: 1,
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }

  function sessionOf(population: 'seller' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'seller' ? OWNER : ADMIN,
        population,
        sellerId: population === 'seller' ? SELLER : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const prove = (action: string) =>
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf102)}|${action}`, clock.now());
  const seller = () => sessionOf('seller', 1);
  const admin = () => sessionOf('admin', 2);

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    population: 'seller' | 'admin',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  const LIST = '/commission-payouts/admin/disputes';
  const ONE = `${LIST}/${DISPUTE}`;
  const DECISION = `${ONE}/seller-orders/${SELLER_ORDER}/decision`;
  const OWN = '/commission-payouts/seller/disputes';
  const body = { bearer: 'seller', amountMinor: '250', reasonCode: 'no-delivery-proof' };
  const money = (amountMinor: bigint) => ({ amountMinor, currency });

  const listView = () => ({
    counts: { 'needs-response': 1, 'decision-needed': 0, 'under-review': 0, won: 0, closed: 0 },
    disputes: [
      {
        disputeId: DISPUTE,
        orderId: ORDER,
        sellers: [{ sellerId: SELLER, storeName: 'Alpha Store' }],
        reason: 'fraudulent',
        moneyState: 'withdrawn',
        status: 'needs_response',
        bucket: 'needs-response',
        evidenceDueBy: START,
        amount: money(2000n),
        openedAt: START,
      },
    ],
    nextCursor: null,
  });
  const detailView = () => ({
    disputeId: DISPUTE,
    orderId: ORDER,
    providerDisputeId: 'dp_1',
    amount: money(2000n),
    status: 'lost',
    inquiry: false,
    closed: true,
    outcome: 'lost',
    reason: 'fraudulent',
    evidenceDueBy: null,
    moneyState: 'withdrawn',
    bucket: 'decision-needed',
    needsReview: false,
    openedAt: START,
    sellerOrders: [
      {
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER,
        storeName: null,
        sellerShare: money(850n),
        recoverableCap: money(850n),
        holdActive: true,
        decision: 'allowed',
        decided: {
          bearer: 'seller',
          amount: money(100n),
          reasonCode: 'other',
          decidedBy: ADMIN,
          decidedAt: START,
          reversal: null,
        },
      },
    ],
    timeline: [{ kind: 'opened', at: START, sellerOrderId: null }],
  });
  const decisionView = () => ({
    disputeId: DISPUTE,
    sellerOrderId: SELLER_ORDER,
    sellerId: SELLER,
    bearer: 'seller',
    amount: money(250n),
    reasonCode: 'no-delivery-proof',
    reversal: false,
    decidedBy: ADMIN,
    decidedAt: START,
    holdsReleased: false,
    bucket: 'decision-needed',
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(null);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lists the cases for an admin, passing the filter, cursor and limit, with money as strings', async () => {
    await boot();
    next = ok(listView());
    const response = await call(
      'get',
      'admin',
      `${LIST}?filter=needs-response&limit=10&cursor=abc`,
      admin(),
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      counts: { 'needs-response': 1, 'decision-needed': 0, 'under-review': 0, won: 0, closed: 0 },
      disputes: [
        {
          disputeId: DISPUTE,
          orderId: ORDER,
          sellers: [{ sellerId: SELLER, storeName: 'Alpha Store' }],
          reason: 'fraudulent',
          moneyState: 'withdrawn',
          status: 'needs_response',
          bucket: 'needs-response',
          evidenceDueBy: START.toString(),
          amount: { amountMinor: '2000', currency },
          openedAt: START.toString(),
        },
      ],
      nextCursor: null,
    });
    expect(calls).toEqual([
      { name: 'list-disputes', input: { filter: 'needs-response', cursor: 'abc', limit: 10 } },
    ]);
  });

  it('shows one case with its seller orders and timeline', async () => {
    await boot();
    next = ok(detailView());
    const response = await call('get', 'admin', ONE, admin());
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      disputeId: DISPUTE,
      providerDisputeId: 'dp_1',
      bucket: 'decision-needed',
      needsReview: false,
      evidenceDueBy: null,
      amount: { amountMinor: '2000', currency },
      sellerOrders: [
        {
          sellerOrderId: SELLER_ORDER,
          sellerShare: { amountMinor: '850', currency },
          recoverableCap: { amountMinor: '850', currency },
          holdActive: true,
          decision: 'allowed',
          decided: { bearer: 'seller', amount: { amountMinor: '100', currency }, reversal: null },
        },
      ],
      timeline: [{ kind: 'opened', at: START.toString(), sellerOrderId: null }],
    });
    expect(calls).toEqual([{ name: 'view-dispute', input: { disputeId: DISPUTE } }]);
  });

  it('records a decision with a fresh proof and answers 201', async () => {
    await boot();
    next = ok(decisionView());
    const session = admin();
    prove(ACTION);
    const response = await call('post', 'admin', DECISION, session, body);
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      disputeId: DISPUTE,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER,
      bearer: 'seller',
      amount: { amountMinor: '250', currency },
      reasonCode: 'no-delivery-proof',
      reversal: false,
      decidedBy: ADMIN,
      decidedAt: START.toString(),
      holdsReleased: false,
      bucket: 'decision-needed',
    });
    expect(calls).toEqual([
      {
        name: 'decide-dispute',
        input: {
          disputeId: DISPUTE,
          sellerOrderId: SELLER_ORDER,
          bearer: 'seller',
          amountMinor: '250',
          reasonCode: 'no-delivery-proof',
        },
      },
    ]);
  });

  it('answers second-factor.required to a decision without a fresh proof', async () => {
    await boot();
    next = ok(decisionView());
    const session = admin();
    const refused = await call('post', 'admin', DECISION, session, body);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: ACTION },
    });
    expect(calls).toEqual([]);
    prove(ACTION);
    expect((await call('post', 'admin', DECISION, session, body)).status).toBe(201);
  });

  it('refuses a decision in an acting-as session, proof or not', async () => {
    await boot();
    next = ok(decisionView());
    const session = admin();
    prove(ACTION);
    const authenticator = app!.get<Authenticator>(AUTHENTICATOR);
    const real = authenticator.authenticate.bind(authenticator);
    const spy = jest.spyOn(authenticator, 'authenticate').mockImplementation(async (m, c) => {
      const result = await real(m, c);
      return result.ok
        ? ok({ ...result.value, actingAs: { sellerId: '01990000-0000-7000-8000-0000000000aa' } })
        : result;
    });
    try {
      const refused = await call('post', 'admin', DECISION, session, body);
      // An acting-as session is not an admin session on an admin route: the exact answer.
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ statusCode: 401, code: 'session.invalid' });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  it('refuses a decision without CSRF, and with a stray field', async () => {
    await boot();
    const session = admin();
    prove(ACTION);
    expect((await call('post', 'admin', DECISION, { cookie: session.cookie }, body)).status).toBe(
      403,
    );
    const stray = await call('post', 'admin', DECISION, session, { ...body, sellerId: SELLER });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
    });
    expect(calls).toEqual([]);
  });

  it('maps the refusals of the dispute routes', async () => {
    await boot();
    const session = admin();
    prove(ACTION);
    const cases: [string, number, () => ReturnType<typeof call>][] = [
      ['validation.failed', 400, () => call('get', 'admin', `${LIST}?filter=x`, session)],
      ['commission-payouts.dispute-not-found', 404, () => call('get', 'admin', ONE, session)],
      [
        'commission-payouts.seller-order-not-found',
        404,
        () => call('post', 'admin', DECISION, session, body),
      ],
      [
        'commission-payouts.dispute.not-decidable',
        409,
        () => call('post', 'admin', DECISION, session, body),
      ],
      [
        'commission-payouts.dispute.already-decided',
        409,
        () => call('post', 'admin', DECISION, session, body),
      ],
      [
        'commission-payouts.dispute.amount-out-of-range',
        400,
        () => call('post', 'admin', DECISION, session, body),
      ],
      ['commission-payouts.unavailable', 503, () => call('get', 'admin', LIST, session)],
      ['access.denied', 403, () => call('get', 'admin', ONE, session)],
    ];
    for (const [refusal, status, run] of cases) {
      next = err({ code: refusal });
      const response = await run();
      expect([refusal, response.status]).toEqual([refusal, status]);
      expect((response.body as { code: string }).code).toBe(refusal);
    }
  });

  it('serves the seller only its own disputed seller orders, with no reason or provider data', async () => {
    await boot();
    next = ok([
      {
        sellerOrderId: SELLER_ORDER,
        orderId: ORDER,
        since: START,
        open: false,
        recoveredAmount: money(250n),
      },
      {
        sellerOrderId: id<'SellerOrder'>(0xc099),
        orderId: id<'Order'>(0xc098),
        since: START.add({ hours: 1 }),
        open: true,
        recoveredAmount: null,
      },
    ]);
    const response = await call('get', 'seller', OWN, seller());
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    // Open ones first.
    expect(response.body).toEqual({
      disputes: [
        {
          sellerOrderId: id<'SellerOrder'>(0xc099),
          orderId: id<'Order'>(0xc098),
          since: START.add({ hours: 1 }).toString(),
          open: true,
          recoveredAmount: null,
        },
        {
          sellerOrderId: SELLER_ORDER,
          orderId: ORDER,
          since: START.toString(),
          open: false,
          recoveredAmount: { amountMinor: '250', currency },
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/reason|dp_|evidence/i);
    next = err({ code: 'access.denied' });
    expect((await call('get', 'seller', OWN, seller())).status).toBe(403);
  });
});
