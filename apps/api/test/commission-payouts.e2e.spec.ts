import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ClearCommissionRate } from '../src/modules/commission-payouts/application/use-cases/clear-commission-rate.use-case';
import { SetCommissionRate } from '../src/modules/commission-payouts/application/use-cases/set-commission-rate.use-case';
import { ClearSellerPayoutTerms } from '../src/modules/commission-payouts/application/use-cases/clear-seller-payout-terms.use-case';
import { ListSellerPayoutHolds } from '../src/modules/commission-payouts/application/use-cases/list-seller-payout-holds.use-case';
import { PlacePayoutHold } from '../src/modules/commission-payouts/application/use-cases/place-payout-hold.use-case';
import { ReleasePayoutHold } from '../src/modules/commission-payouts/application/use-cases/release-payout-hold.use-case';
import { SetSellerPayoutTerms } from '../src/modules/commission-payouts/application/use-cases/set-seller-payout-terms.use-case';
import { ViewSellerPayoutTerms } from '../src/modules/commission-payouts/application/use-cases/view-seller-payout-terms.use-case';
import { COMMISSION_PAYOUTS_STEP_UP_ACTIONS } from '../src/modules/commission-payouts/contracts/step-up';
import {
  COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE,
  COMMISSION_PAYOUTS_DISPUTE_VIEW,
  COMMISSION_PAYOUTS_RATE_EDIT,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
  COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT,
  COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW,
} from '../src/modules/commission-payouts/contracts/permissions';
import { ViewCommissionRate } from '../src/modules/commission-payouts/application/use-cases/view-commission-rate.use-case';
import { ViewOwnLedger } from '../src/modules/commission-payouts/application/use-cases/view-own-ledger.use-case';
import { ViewSellerLedger } from '../src/modules/commission-payouts/application/use-cases/view-seller-ledger.use-case';
import { COMMISSION_PAYOUTS_STATUS } from '../src/modules/commission-payouts/presentation/http-answers';
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

// The commission rate routes (admin) and the ledger routes (admin and seller) over HTTP: the real
// guards and controllers; the use cases are stubs, so this proves the session, the panel
// population, CSRF, the closed bodies, the status of each refusal, the answer shape and
// `no-store`. The use cases have their own spec.

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

const ledger = (currency: string) => ({
  sellerId: SELLER,
  currency,
  totals: {
    sales: 1435n,
    shipping: 500n,
    commission: 196n,
    refundedSales: 300n,
    refundedShipping: 50n,
    refundedCommission: 45n,
    disputeDebits: 0n,
    disputeReinstated: 0n,
    balance: 1434n,
  },
  entries: [
    {
      entryId: id<'LedgerEntry'>(0xd001),
      orderId: id<'Order'>(0xc021),
      sellerOrderId: id<'SellerOrder'>(0xc020),
      orderLineId: id<'OrderLine'>(0xc030),
      kind: 'commission',
      direction: 'debit',
      amount: 150n,
      rateBps: 1500,
      baseAmount: 1000n,
      sourceId: null,
      occurredAt: START,
      recordedAt: START,
    },
  ],
  nextCursor: null,
});

it('maps every refusal code of the commission-payouts routes to its exact status', () => {
  expect(COMMISSION_PAYOUTS_STATUS).toEqual({
    'validation.failed': 400,
    'commission-payouts.seller-not-found': 404,
    'commission-payouts.rate-not-set': 404,
    'commission-payouts.rate-unavailable': 503,
    'commission-payouts.terms-not-set': 404,
    'commission-payouts.terms-unavailable': 503,
    'commission-payouts.version-conflict': 409,
    'commission-payouts.seller-order-not-found': 404,
    'commission-payouts.hold-not-found': 404,
    'commission-payouts.hold-already-released': 409,
    'commission-payouts.dispute-not-found': 404,
    'commission-payouts.dispute.not-decidable': 409,
    'commission-payouts.dispute.already-decided': 409,
    'commission-payouts.dispute.amount-out-of-range': 400,
    'commission-payouts.unavailable': 503,
  });
});

it('declares the payout terms view as unprotected and every change (the commission rate included) as protected, each with an admin step-up action', () => {
  // The use-case gate only checks that the admin holds the key. The fresh second factor (and the
  // refusal of an acting-as session) is the route's `@RequiresStepUp` guard (H-1); the routes are
  // exercised below, one by one.
  expect(
    [
      COMMISSION_PAYOUTS_RATE_EDIT,
      COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW,
      COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT,
      COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE,
      COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
      COMMISSION_PAYOUTS_DISPUTE_VIEW,
      COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE,
    ].map((p) => [p.key, p.scope, p.protected]),
  ).toEqual([
    ['commission-payouts.commission-rate.edit', 'platform', true],
    ['commission-payouts.payout-terms.view', 'platform', false],
    ['commission-payouts.payout-terms.edit', 'platform', true],
    ['commission-payouts.payout-hold.place', 'platform', true],
    ['commission-payouts.payout-hold.release', 'platform', true],
    ['commission-payouts.dispute.view', 'platform', false],
    ['commission-payouts.dispute.attribute', 'platform', true],
  ]);
  expect(COMMISSION_PAYOUTS_STEP_UP_ACTIONS).toEqual([
    {
      key: 'commission-payouts.commission-rate.edit',
      defaultRequired: true,
      locked: true,
      audience: 'admin',
    },
    {
      key: 'commission-payouts.payout-terms.edit',
      defaultRequired: true,
      locked: true,
      audience: 'admin',
    },
    {
      key: 'commission-payouts.payout-hold.place',
      defaultRequired: true,
      locked: true,
      audience: 'admin',
    },
    {
      key: 'commission-payouts.payout-hold.release',
      defaultRequired: true,
      locked: true,
      audience: 'admin',
    },
    {
      key: 'commission-payouts.dispute.attribute',
      defaultRequired: true,
      locked: true,
      audience: 'admin',
    },
  ]);
});

describe.each(TEST_MARKETS)('commission and ledger over HTTP in market %s', (code) => {
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
          .overrideProvider(ViewCommissionRate)
          .useValue(stub('view-rate'))
          .overrideProvider(SetCommissionRate)
          .useValue(stub('set-rate'))
          .overrideProvider(ClearCommissionRate)
          .useValue(stub('clear-rate'))
          .overrideProvider(ViewSellerLedger)
          .useValue(stub('seller-ledger'))
          .overrideProvider(ViewOwnLedger)
          .useValue(stub('own-ledger'))
          .overrideProvider(ViewSellerPayoutTerms)
          .useValue(stub('view-terms'))
          .overrideProvider(SetSellerPayoutTerms)
          .useValue(stub('set-terms'))
          .overrideProvider(ClearSellerPayoutTerms)
          .useValue(stub('clear-terms'))
          .overrideProvider(ListSellerPayoutHolds)
          .useValue(stub('list-holds'))
          .overrideProvider(PlacePayoutHold)
          .useValue(stub('place-hold'))
          .overrideProvider(ReleasePayoutHold)
          .useValue(stub('release-hold')),
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
  const proveAll = () =>
    [
      'commission-payouts.commission-rate.edit',
      'commission-payouts.payout-terms.edit',
      'commission-payouts.payout-hold.place',
      'commission-payouts.payout-hold.release',
    ].forEach(prove);
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
  const RATE = `/commission-payouts/admin/sellers/${SELLER}/commission-rate`;
  const LEDGER = `/commission-payouts/admin/sellers/${SELLER}/ledger`;
  const OWN = '/commission-payouts/seller/ledger';
  const rate = { sellerId: SELLER, rateBps: 1200, source: 'seller', marketRateBps: 1500 };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(rate);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read, set and remove a seller rate, passing the input to the use case', async () => {
    await boot();
    const session = admin();
    prove('commission-payouts.commission-rate.edit');

    const read = await call('get', 'admin', RATE, session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual(rate);
    const set = await call('put', 'admin', RATE, session, { rateBps: 1200 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual(rate);
    const cleared = await call('delete', 'admin', RATE, session);
    expect(cleared.status).toBe(200);
    expect(calls).toEqual([
      { name: 'view-rate', input: { sellerId: SELLER } },
      { name: 'set-rate', input: { sellerId: SELLER, rateBps: 1200 } },
      { name: 'clear-rate', input: { sellerId: SELLER } },
    ]);
  });

  it('refuses a write without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = admin();
    prove('commission-payouts.commission-rate.edit');

    expect(
      (await call('put', 'admin', RATE, { cookie: session.cookie }, { rateBps: 1 })).status,
    ).toBe(403);
    expect((await call('delete', 'admin', RATE, { cookie: session.cookie })).status).toBe(403);
    const extra = await call('put', 'admin', RATE, session, { rateBps: 1, source: 'market' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'source', code: 'unknown-field' }] },
    });
    const text = await http()
      .put(RATE)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, unknown seller, nothing to remove, unavailable and denied', async () => {
    await boot();
    const session = admin();
    prove('commission-payouts.commission-rate.edit');
    const put = () => call('put', 'admin', RATE, session, { rateBps: 1 });

    next = err({ code: 'validation.failed', fields: [{ path: 'rateBps', code: 'range' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'rateBps', code: 'range' }] },
    });
    next = err({ code: 'commission-payouts.seller-not-found' });
    expect((await put()).status).toBe(404);
    next = err({ code: 'commission-payouts.unavailable' });
    expect((await put()).status).toBe(503);
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
    next = err({ code: 'commission-payouts.rate-not-set' });
    expect((await call('delete', 'admin', RATE, session)).status).toBe(404);
  });

  it('serves the ledger to an admin and to the seller, with money as strings', async () => {
    await boot();
    next = ok(ledger(currency));

    const byAdmin = await call('get', 'admin', `${LEDGER}?limit=10&cursor=abc`, admin());
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.headers['cache-control']).toBe('no-store');
    const own = await call('get', 'seller', OWN, seller());
    expect(own.status).toBe(200);
    expect(own.body).toEqual({
      sellerId: SELLER,
      currency,
      totals: {
        sales: '1435',
        shipping: '500',
        commission: '196',
        refundedSales: '300',
        refundedShipping: '50',
        refundedCommission: '45',
        disputeDebits: '0',
        disputeReinstated: '0',
        balance: '1434',
      },
      entries: [
        {
          entryId: id<'LedgerEntry'>(0xd001),
          orderId: id<'Order'>(0xc021),
          sellerOrderId: id<'SellerOrder'>(0xc020),
          orderLineId: id<'OrderLine'>(0xc030),
          kind: 'commission',
          direction: 'debit',
          amount: '150',
          rateBps: 1500,
          baseAmount: '1000',
          sourceId: null,
          occurredAt: START.toString(),
          recordedAt: START.toString(),
        },
      ],
      nextCursor: null,
    });
    expect(calls).toEqual([
      { name: 'seller-ledger', input: { sellerId: SELLER, cursor: 'abc', limit: 10 } },
      { name: 'own-ledger', input: { cursor: undefined, limit: undefined } },
    ]);
  });

  describe('payout terms and holds', () => {
    const TERMS = `/commission-payouts/admin/sellers/${SELLER}/payout-terms`;
    const HOLDS = `/commission-payouts/admin/sellers/${SELLER}/payout-holds`;
    const HOLD = id<'PayoutHold'>(0xa501);
    const RELEASE = `/commission-payouts/admin/payout-holds/${HOLD}/release`;
    const terms = {
      sellerId: SELLER,
      effective: {
        weekdays: ['TUE'],
        localTime: '10:00',
        holdDaysCarrier: 9,
        holdDaysSellerClick: 14,
        minimumMinor: 5000n,
        approvalMode: 'AUTO',
        firstPayoutManual: true,
      },
      source: 'seller',
      override: {
        weekdays: null,
        localTime: null,
        holdDaysCarrier: 9,
        holdDaysSellerClick: null,
        minimumMinor: null,
        approvalMode: null,
      },
      version: 2,
    };
    const hold = {
      holdId: HOLD,
      sellerId: SELLER,
      sellerOrderId: null,
      reason: 'admin-review',
      origin: 'admin',
      placedAt: START,
      active: true,
      releasedAt: null,
      releaseReason: null,
    };

    it('reads, sets and removes terms, passing the version and turning money into a string', async () => {
      await boot();
      next = ok(terms);
      const session = admin();
      proveAll();

      const read = await call('get', 'admin', TERMS, session);
      expect(read.status).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body).toMatchObject({
        source: 'seller',
        version: 2,
        effective: { minimumMinor: '5000', holdDaysCarrier: 9 },
        override: { holdDaysCarrier: 9, minimumMinor: null },
      });
      const set = await call('put', 'admin', TERMS, session, {
        holdDaysCarrier: 9,
        expectedVersion: 1,
        reasonCode: 'correction',
      });
      expect(set.status).toBe(200);
      expect(
        (await call('delete', 'admin', `${TERMS}?expectedVersion=2&reasonCode=policy`, session))
          .status,
      ).toBe(200);
      expect((await call('delete', 'admin', TERMS, session)).status).toBe(200);
      expect(calls).toEqual([
        { name: 'view-terms', input: { sellerId: SELLER } },
        {
          name: 'set-terms',
          input: {
            sellerId: SELLER,
            terms: { holdDaysCarrier: 9 },
            expectedVersion: 1,
            reasonCode: 'correction',
          },
        },
        {
          name: 'clear-terms',
          input: { sellerId: SELLER, expectedVersion: 2, reasonCode: 'policy' },
        },
        // A missing version reaches the use case as an invalid one, which it refuses.
        {
          name: 'clear-terms',
          input: { sellerId: SELLER, expectedVersion: -1, reasonCode: undefined },
        },
      ]);
    });

    it('refuses a terms or hold write without CSRF, and with a stray field', async () => {
      await boot();
      const session = admin();
      proveAll();
      const noCsrf = { cookie: session.cookie };

      expect((await call('put', 'admin', TERMS, noCsrf, { holdDaysCarrier: 9 })).status).toBe(403);
      expect((await call('delete', 'admin', `${TERMS}?expectedVersion=1`, noCsrf)).status).toBe(
        403,
      );
      expect((await call('post', 'admin', HOLDS, noCsrf, { reason: 'admin-review' })).status).toBe(
        403,
      );
      expect((await call('post', 'admin', RELEASE, noCsrf, { reason: 'resolved' })).status).toBe(
        403,
      );
      const stray = await call('put', 'admin', TERMS, session, { holdDays: 9 });
      expect(stray.status).toBe(400);
      expect(stray.body).toMatchObject({
        details: { fields: [{ path: 'holdDays', code: 'unknown-field' }] },
      });
      expect(
        (await call('post', 'admin', HOLDS, session, { reason: 'admin-review', placedBy: 'x' }))
          .status,
      ).toBe(400);
      expect((await call('post', 'admin', RELEASE, session, { holdId: HOLD })).status).toBe(400);
      expect(calls).toEqual([]);
    });

    it('lists, places and releases holds', async () => {
      await boot();
      const session = admin();
      proveAll();

      next = ok([hold]);
      const listed = await call('get', 'admin', HOLDS, session);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        holds: [{ ...hold, placedAt: START.toString() }],
      });
      next = ok(hold);
      const placed = await call('post', 'admin', HOLDS, session, {
        reason: 'admin-review',
        sellerOrderId: id<'SellerOrder'>(0xc020),
      });
      expect(placed.status).toBe(201);
      expect(placed.headers['cache-control']).toBe('no-store');
      next = ok({ ...hold, active: false, releasedAt: START, releaseReason: 'resolved' });
      const released = await call('post', 'admin', RELEASE, session, { reason: 'resolved' });
      expect(released.status).toBe(200);
      expect(released.body).toMatchObject({
        active: false,
        releasedAt: START.toString(),
        releaseReason: 'resolved',
      });
      expect(calls).toEqual([
        { name: 'list-holds', input: { sellerId: SELLER } },
        {
          name: 'place-hold',
          input: {
            sellerId: SELLER,
            sellerOrderId: id<'SellerOrder'>(0xc020),
            reason: 'admin-review',
          },
        },
        { name: 'release-hold', input: { holdId: HOLD, reason: 'resolved' } },
      ]);
    });

    it('maps the refusals of the terms and hold routes', async () => {
      await boot();
      const session = admin();
      proveAll();
      const cases: [string, number, () => ReturnType<typeof call>][] = [
        [
          'commission-payouts.version-conflict',
          409,
          () => call('put', 'admin', TERMS, session, { holdDaysCarrier: 9 }),
        ],
        ['commission-payouts.terms-unavailable', 503, () => call('get', 'admin', TERMS, session)],
        [
          'commission-payouts.terms-not-set',
          404,
          () => call('delete', 'admin', `${TERMS}?expectedVersion=1`, session),
        ],
        [
          'commission-payouts.seller-order-not-found',
          404,
          () => call('post', 'admin', HOLDS, session, { reason: 'admin-review' }),
        ],
        [
          'commission-payouts.hold-not-found',
          404,
          () => call('post', 'admin', RELEASE, session, { reason: 'resolved' }),
        ],
        [
          'commission-payouts.hold-already-released',
          409,
          () => call('post', 'admin', RELEASE, session, { reason: 'resolved' }),
        ],
        [
          'access.denied',
          403,
          () => call('post', 'admin', RELEASE, session, { reason: 'resolved' }),
        ],
      ];
      for (const [code, status, run] of cases) {
        next = err({ code });
        const response = await run();
        expect([code, response.status]).toEqual([code, status]);
        expect((response.body as { code: string }).code).toBe(code);
      }
    });
    const GUARDED: [string, 'put' | 'delete' | 'post', () => string, object | undefined][] = [
      ['commission-payouts.commission-rate.edit', 'put', () => RATE, { rateBps: 1200 }],
      ['commission-payouts.commission-rate.edit', 'delete', () => RATE, undefined],
      [
        'commission-payouts.payout-terms.edit',
        'put',
        () => TERMS,
        { holdDaysCarrier: 9, reasonCode: 'policy' },
      ],
      [
        'commission-payouts.payout-terms.edit',
        'delete',
        () => `${TERMS}?expectedVersion=1&reasonCode=policy`,
        undefined,
      ],
      ['commission-payouts.payout-hold.place', 'post', () => HOLDS, { reason: 'admin-review' }],
      ['commission-payouts.payout-hold.release', 'post', () => RELEASE, { reason: 'resolved' }],
    ];

    it.each(GUARDED)(
      'answers second-factor.required to %s (%s) without a fresh proof, and a proof of another action does not do',
      async (action, method, path, body) => {
        await boot();
        next = action.includes('rate') ? ok(rate) : action.includes('terms') ? ok(terms) : ok(hold);
        const session = admin();
        const refused = await call(method, 'admin', path(), session, body);
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({
          statusCode: 403,
          code: 'second-factor.required',
          details: { actionKey: action },
        });
        for (const other of GUARDED.map(([key]) => key).filter((key) => key !== action)) {
          prove(other);
        }
        expect((await call(method, 'admin', path(), session, body)).status).toBe(403);
        expect(calls).toEqual([]);
        prove(action);
        expect((await call(method, 'admin', path(), session, body)).status).toBeLessThan(300);
        expect(calls).toHaveLength(1);
      },
    );

    it.each(GUARDED)(
      'refuses an acting-as session on %s (%s), proof or not',
      async (action, method, path, body) => {
        await boot();
        const session = admin();
        proveAll();
        const authenticator = app!.get<Authenticator>(AUTHENTICATOR);
        const real = authenticator.authenticate.bind(authenticator);
        const spy = jest.spyOn(authenticator, 'authenticate').mockImplementation(async (m, c) => {
          const result = await real(m, c);
          return result.ok
            ? ok({
                ...result.value,
                actingAs: { sellerId: '01990000-0000-7000-8000-0000000000aa' },
              })
            : result;
        });
        try {
          const refused = await call(method, 'admin', path(), session, body);
          expect([401, 403]).toContain(refused.status);
          expect(refused.status).toBeGreaterThanOrEqual(401);
        } finally {
          spy.mockRestore();
        }
        expect(calls).toEqual([]);
        expect(action).toBeDefined();
      },
    );
  });
});
