import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CreateOwnPromotion } from '../src/modules/promotions/application/use-cases/create-own-promotion.use-case';
import { CreatePromotion } from '../src/modules/promotions/application/use-cases/create-promotion.use-case';
import { DecidePromotionReview } from '../src/modules/promotions/application/use-cases/decide-promotion-review.use-case';
import { EditOwnPromotion } from '../src/modules/promotions/application/use-cases/edit-own-promotion.use-case';
import { EditPromotion } from '../src/modules/promotions/application/use-cases/edit-promotion.use-case';
import { ListFreeShippingThresholds } from '../src/modules/promotions/application/use-cases/list-free-shipping-thresholds.use-case';
import { ListOwnPromotions } from '../src/modules/promotions/application/use-cases/list-own-promotions.use-case';
import { ListPromotionReviews } from '../src/modules/promotions/application/use-cases/list-promotion-reviews.use-case';
import { ListPromotionsFull } from '../src/modules/promotions/application/use-cases/list-promotions-full.use-case';
import { ListPromotions } from '../src/modules/promotions/application/use-cases/list-promotions.use-case';
import { PauseOwnPromotion } from '../src/modules/promotions/application/use-cases/pause-own-promotion.use-case';
import { PausePromotion } from '../src/modules/promotions/application/use-cases/pause-promotion.use-case';
import { PreviewQuote } from '../src/modules/promotions/application/use-cases/preview-quote.use-case';
import { ResumeOwnPromotion } from '../src/modules/promotions/application/use-cases/resume-own-promotion.use-case';
import { ResumePromotion } from '../src/modules/promotions/application/use-cases/resume-promotion.use-case';
import { SetCoFundingOptIn } from '../src/modules/promotions/application/use-cases/set-co-funding-opt-in.use-case';
import { SetFirstOrderSettings } from '../src/modules/promotions/application/use-cases/set-first-order-settings.use-case';
import { SetFreeShippingThreshold } from '../src/modules/promotions/application/use-cases/set-free-shipping-threshold.use-case';
import { SetPromotionBudget } from '../src/modules/promotions/application/use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from '../src/modules/promotions/application/use-cases/set-promotions-status.use-case';
import { ViewFirstOrderSettings } from '../src/modules/promotions/application/use-cases/view-first-order-settings.use-case';
import { ViewPromotion } from '../src/modules/promotions/application/use-cases/view-promotion.use-case';
import { ViewPromotionsSettings } from '../src/modules/promotions/application/use-cases/view-promotions-settings.use-case';
import { PROMOTIONS_STATUS } from '../src/modules/promotions/presentation/http-answers';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The promotions routes over HTTP: the real guards and controllers; the use cases are stubs, so
// this proves the session, the population of each route, CSRF, the closed body and query, the
// status of each refusal, the answer shape and `no-store`. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const SELLER_ACCOUNT = id<'Account'>(0xa201);
const SELLER = id<'Seller'>(0x5e1);
const PROMOTION = id<'Promotion'>(0xe001);
const itemsOf = (response: { body: unknown }) => (response.body as { items: object[] }).items;
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the promotions routes to its exact status', () => {
  expect(PROMOTIONS_STATUS).toEqual({
    'validation.failed': 400,
    'second-factor.required': 403,
    'second-factor.enrolment-required': 403,
    'promotions.disabled': 404,
    'promotions.not-found': 404,
    'promotions.code-taken': 409,
    'promotions.invalid-state': 409,
    'promotions.not-editable': 409,
    'access.unavailable': 503,
    'promotions.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('promotions over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  let actors: string[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const stub = (name: string) => ({
    execute: (context: { actor: { kind: string; population?: string } }, input: unknown) => {
      calls.push({ name, input });
      actors.push(
        context.actor.kind === 'authenticated' ? context.actor.population! : context.actor.kind,
      );
      return Promise.resolve(next);
    },
  });

  const USE_CASES = [
    ['view-settings', ViewPromotionsSettings],
    ['set-status', SetPromotionsStatus],
    ['list-usage', ListPromotions],
    ['list-full', ListPromotionsFull],
    ['view', ViewPromotion],
    ['create', CreatePromotion],
    ['edit', EditPromotion],
    ['pause', PausePromotion],
    ['resume', ResumePromotion],
    ['budget', SetPromotionBudget],
    ['list-reviews', ListPromotionReviews],
    ['decide-review', DecidePromotionReview],
    ['view-first-order', ViewFirstOrderSettings],
    ['set-first-order', SetFirstOrderSettings],
    ['list-thresholds', ListFreeShippingThresholds],
    ['set-threshold', SetFreeShippingThreshold],
    ['preview', PreviewQuote],
    ['create-own', CreateOwnPromotion],
    ['edit-own', EditOwnPromotion],
    ['pause-own', PauseOwnPromotion],
    ['resume-own', ResumeOwnPromotion],
    ['list-own', ListOwnPromotions],
    ['opt-in', SetCoFundingOptIn],
  ] as const;

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        USE_CASES.reduce(
          (b, [name, type]) => b.overrideProvider(type as never).useValue(stub(name)),
          fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
        ),
    }));
    for (const [accountId, population, label] of [
      [CUSTOMER, 'customer', 'shopper'],
      [ADMIN, 'admin', 'admin'],
      [SELLER_ACCOUNT, 'seller', 'seller'],
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
    seedSeller();
  }
  function seedSeller() {
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
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: SELLER_ACCOUNT,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }
  function sessionOf(population: 'customer' | 'admin' | 'seller', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId:
          population === 'customer' ? CUSTOMER : population === 'admin' ? ADMIN : SELLER_ACCOUNT,
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
  const admin = () => sessionOf('admin', 2);
  const seller = () => sessionOf('seller', 3);
  const customer = () => sessionOf('customer', 1);

  const call = (
    population: 'admin' | 'seller',
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  const PROMOTION_VIEW = {
    id: PROMOTION,
    type: 'CART_DISCOUNT',
    status: 'ACTIVE',
    name: 'Platform cart',
    funding: 'PLATFORM',
    ownerSellerId: null,
    combinable: true,
    code: null,
    startsAt: START,
    endsAt: null,
    testMode: true,
    reward: { kind: 'PERCENT', bps: 500 },
    currency: 'AUD',
    minSpendMinor: null,
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    productIds: [],
    sellerIds: [],
    zones: [],
    createdAt: START,
    updatedAt: START,
    platformSplitBps: null,
    specialCampaign: false,
    priorApproved: false,
    pausedBy: null,
    capMinor: null,
    maxPerOrderMinor: null,
    budgetMinor: 100000n,
    usage: { usesCount: 3, spentMinor: 900n, sellerShareMinor: 0n, platformShareMinor: 900n },
  };
  const OWN_VIEW = {
    ...PROMOTION_VIEW,
    ownerSellerId: SELLER,
    funding: 'SELLER',
    type: 'SELLER_SALE',
    usesCount: 3,
    spentMinor: 900n,
  };
  const BODY = {
    type: 'CART_DISCOUNT',
    name: 'Platform cart',
    funding: 'PLATFORM',
    startsAt: START.toString(),
    reward: { kind: 'PERCENT', bps: 500 },
    budgetMinor: '100000',
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    actors = [];
    next = ok({ status: 'active', updatedAt: START });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read and set the switch, and refuses a stray field, no CSRF and a non-JSON body', async () => {
    await boot();
    const session = admin();
    const read = await call('admin', 'get', '/promotions/admin/settings', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({ status: 'active', updatedAt: START.toString() });
    expect(
      (await call('admin', 'put', '/promotions/admin/settings', session, { status: 'active' }))
        .status,
    ).toBe(200);
    expect(calls).toEqual([
      { name: 'view-settings', input: {} },
      { name: 'set-status', input: { status: 'active' } },
    ]);
    expect(
      (
        await call(
          'admin',
          'put',
          '/promotions/admin/settings',
          { cookie: session.cookie },
          { status: 'active' },
        )
      ).status,
    ).toBe(403);
    const extra = await call('admin', 'put', '/promotions/admin/settings', session, {
      status: 'active',
      enabled: true,
    });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'enabled', code: 'unknown-field' }] },
    });
    const text = await http()
      .put('/promotions/admin/settings')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    next = err({ code: 'access.denied' });
    expect(
      (await call('admin', 'put', '/promotions/admin/settings', session, { status: 'off' })).status,
    ).toBe(403);
  });

  it('reads only the session of the route population: any other cookie reaches the use case as anonymous', async () => {
    await boot();
    for (const session of [seller(), customer()]) {
      await call('admin', 'get', '/promotions/admin/settings', session);
    }
    await call('seller', 'get', '/promotions/seller/promotions', admin());
    expect(actors).toEqual(['anonymous', 'anonymous', 'anonymous']);
    await call('admin', 'get', '/promotions/admin/settings', admin());
    await call('seller', 'get', '/promotions/seller/promotions', seller());
    expect(actors.slice(3)).toEqual(['admin', 'seller']);
  });

  it('lists promotions for a Viewer with usage only and for a manager with the cost, checking the query', async () => {
    await boot();
    const session = admin();
    next = ok([{ ...PROMOTION_VIEW, usesCount: 3 }]);
    const usage = await call(
      'admin',
      'get',
      '/promotions/admin/promotions?status=ACTIVE&limit=5',
      session,
    );
    expect(usage.status).toBe(200);
    expect(usage.headers['cache-control']).toBe('no-store');
    expect(itemsOf(usage)[0]).toMatchObject({
      id: PROMOTION,
      usesCount: 3,
      name: 'Platform cart',
    });
    expect(itemsOf(usage)[0]).not.toHaveProperty('budgetMinor');
    expect(calls.at(-1)).toEqual({ name: 'list-usage', input: { status: 'ACTIVE', limit: 5 } });

    next = ok([PROMOTION_VIEW]);
    const full = await call('admin', 'get', '/promotions/admin/promotions/costs', session);
    expect(full.status).toBe(200);
    expect(itemsOf(full)[0]).toMatchObject({
      budgetMinor: '100000',
      usage: { spentMinor: '900', platformShareMinor: '900' },
      reward: { kind: 'PERCENT', bps: 500, amountMinor: null },
    });
    const stray = await call('admin', 'get', '/promotions/admin/promotions?sort=asc', session);
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      details: { fields: [{ path: 'sort', code: 'unknown-field' }] },
    });
  });

  it('creates, edits, pauses, resumes and sets the budget of a promotion, passing the id and the body', async () => {
    await boot();
    const session = admin();
    next = ok(PROMOTION_VIEW);
    const created = await call('admin', 'post', '/promotions/admin/promotions', session, BODY);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: PROMOTION, budgetMinor: '100000' });
    expect(
      (await call('admin', 'patch', `/promotions/admin/promotions/${PROMOTION}`, session, BODY))
        .status,
    ).toBe(200);
    expect(
      (await call('admin', 'post', `/promotions/admin/promotions/${PROMOTION}/pause`, session))
        .status,
    ).toBe(200);
    expect(
      (await call('admin', 'post', `/promotions/admin/promotions/${PROMOTION}/resume`, session))
        .status,
    ).toBe(200);
    expect(
      (
        await call('admin', 'put', `/promotions/admin/promotions/${PROMOTION}/budget`, session, {
          budgetMinor: '150000',
        })
      ).status,
    ).toBe(200);
    expect(calls).toEqual([
      { name: 'create', input: BODY },
      { name: 'edit', input: { ...BODY, promotionId: PROMOTION } },
      { name: 'pause', input: { promotionId: PROMOTION } },
      { name: 'resume', input: { promotionId: PROMOTION } },
      { name: 'budget', input: { promotionId: PROMOTION, budgetMinor: '150000' } },
    ]);
    const stray = await call('admin', 'post', '/promotions/admin/promotions', session, {
      ...BODY,
      status: 'ACTIVE',
    });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      details: { fields: [{ path: 'status', code: 'unknown-field' }] },
    });
  });

  it('answers a missing fresh code as 403 with the action key, and the other refusals with their status', async () => {
    await boot();
    const session = admin();
    next = err({
      code: 'second-factor.required',
      actionKey: 'promotions.platform-funding.approve',
    });
    const stepUp = await call('admin', 'post', '/promotions/admin/promotions', session, BODY);
    expect(stepUp.status).toBe(403);
    expect(stepUp.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'promotions.platform-funding.approve' },
    });
    for (const [failure, status] of [
      [{ code: 'promotions.disabled' }, 404],
      [{ code: 'promotions.code-taken' }, 409],
      [{ code: 'promotions.not-editable' }, 409],
      [{ code: 'promotions.unavailable' }, 503],
      [{ code: 'validation.failed', fields: [{ path: 'budgetMinor', code: 'required' }] }, 400],
    ] as const) {
      next = err(failure);
      const answer = await call('admin', 'post', '/promotions/admin/promotions', session, BODY);
      expect(answer.status).toBe(status);
      expect((answer.body as { code: string }).code).toBe(failure.code);
    }
    next = err({ code: 'something.new' });
    expect(
      (await call('admin', 'post', '/promotions/admin/promotions', session, BODY)).status,
    ).toBe(500);
  });

  it('reads and decides the review queue, and reads and sets the first-order and shipping settings', async () => {
    await boot();
    const session = admin();
    const review = {
      id: id<'PromotionReview'>(0xe101),
      promotionId: PROMOTION,
      sellerId: SELLER,
      reason: 'NEW_SELLER',
      status: 'OPEN',
      openedAt: START,
      decidedAt: null,
    };
    next = ok([{ review, promotion: PROMOTION_VIEW }]);
    const queue = await call('admin', 'get', '/promotions/admin/reviews', session);
    expect(queue.status).toBe(200);
    expect((itemsOf(queue)[0] as { review: unknown }).review).toMatchObject({
      reason: 'NEW_SELLER',
      decidedAt: null,
    });
    next = ok({
      review: { ...review, status: 'APPROVED', decidedAt: START },
      promotion: PROMOTION_VIEW,
    });
    const decided = await call('admin', 'put', `/promotions/admin/reviews/${review.id}`, session, {
      decision: 'APPROVE',
    });
    expect(decided.status).toBe(200);
    expect(calls.at(-1)).toEqual({
      name: 'decide-review',
      input: { reviewId: review.id, decision: 'APPROVE' },
    });

    next = ok({
      settings: {
        enabled: true,
        kind: 'FIXED',
        percentBps: null,
        amountMinor: 800n,
        capMinor: null,
        minSpendMinor: 3000n,
        monthlyBudgetMinor: 100000n,
      },
      source: 'stored',
      currency: 'AUD',
    });
    const first = await call('admin', 'get', '/promotions/admin/first-order', session);
    expect(first.body).toMatchObject({
      source: 'stored',
      settings: { amountMinor: '800', minSpendMinor: '3000' },
    });
    const firstBody = {
      enabled: true,
      kind: 'FIXED',
      amountMinor: '800',
      minSpendMinor: '3000',
      monthlyBudgetMinor: '100000',
    };
    expect(
      (await call('admin', 'put', '/promotions/admin/first-order', session, firstBody)).status,
    ).toBe(200);
    expect(calls.at(-1)).toEqual({ name: 'set-first-order', input: firstBody });

    next = ok({
      currency: 'AUD',
      defaultThresholdMinor: 5000n,
      zones: [{ zoneCode: 'remote', thresholdMinor: 12000n }],
    });
    const thresholds = await call('admin', 'get', '/promotions/admin/free-shipping', session);
    expect(thresholds.body).toEqual({
      currency: 'AUD',
      defaultThresholdMinor: '5000',
      zones: [{ zoneCode: 'remote', thresholdMinor: '12000' }],
    });
    next = ok({ zoneCode: 'remote', thresholdMinor: 12000n });
    const set = await call('admin', 'put', '/promotions/admin/free-shipping/remote', session, {
      thresholdMinor: '12000',
    });
    expect(set.body).toEqual({ zoneCode: 'remote', thresholdMinor: '12000' });
    expect(calls.at(-1)).toEqual({
      name: 'set-threshold',
      input: { zoneCode: 'remote', thresholdMinor: '12000' },
    });
  });

  it('previews a quote for an admin', async () => {
    await boot();
    next = ok({
      enabled: true,
      currency: 'AUD',
      code: 'NONE',
      lines: [],
      shipping: [],
      applied: [],
      totals: {
        goodsGross: 0n,
        goodsDiscount: 0n,
        goodsNet: 0n,
        sellerShare: 0n,
        platformShare: 0n,
        shippingGross: 0n,
        shippingDiscount: 0n,
        shippingNet: 0n,
        payable: 0n,
      },
    });
    const body = {
      lines: [
        { id: 'l1', productId: PROMOTION, sellerId: SELLER, unitPriceMinor: '100', quantity: 1 },
      ],
    };
    const answer = await call('admin', 'post', '/promotions/admin/preview-quote', admin(), body);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ enabled: true, totals: { payableMinor: '0' } });
    expect(calls.at(-1)).toEqual({ name: 'preview', input: body });
  });

  it('lets a seller list, create, edit, pause, resume and opt in, and takes no seller id from the request', async () => {
    await boot();
    const session = seller();
    next = ok([OWN_VIEW]);
    const listed = await call('seller', 'get', '/promotions/seller/promotions', session);
    expect(listed.status).toBe(200);
    expect(itemsOf(listed)[0]).toMatchObject({ id: PROMOTION, usesCount: 3, spentMinor: '900' });
    expect(itemsOf(listed)[0]).not.toHaveProperty('usage');

    next = ok(OWN_VIEW);
    const saleBody = {
      type: 'SELLER_SALE',
      name: 'Sale',
      funding: 'SELLER',
      startsAt: START.toString(),
      reward: { kind: 'PERCENT', bps: 1000 },
      productIds: [id<'Product'>(0x1001)],
    };
    const created = await call(
      'seller',
      'post',
      '/promotions/seller/promotions',
      session,
      saleBody,
    );
    expect(created.status).toBe(201);
    await call('seller', 'patch', `/promotions/seller/promotions/${PROMOTION}`, session, saleBody);
    await call('seller', 'post', `/promotions/seller/promotions/${PROMOTION}/pause`, session);
    await call('seller', 'post', `/promotions/seller/promotions/${PROMOTION}/resume`, session);
    next = ok({ promotionId: PROMOTION, optedIn: true });
    const opted = await call(
      'seller',
      'put',
      `/promotions/seller/campaigns/${PROMOTION}/opt-in`,
      session,
      {
        optIn: true,
      },
    );
    expect(opted.body).toEqual({ promotionId: PROMOTION, optedIn: true });
    expect(calls.map((c) => c.name)).toEqual([
      'list-own',
      'create-own',
      'edit-own',
      'pause-own',
      'resume-own',
      'opt-in',
    ]);
    const forged = await call('seller', 'post', '/promotions/seller/promotions', session, {
      ...saleBody,
      ownerSellerId: id<'Seller'>(0x5e2),
    });
    expect(forged.status).toBe(400);
    expect(forged.body).toMatchObject({
      details: { fields: [{ path: 'ownerSellerId', code: 'unknown-field' }] },
    });
  });

  it('does not expose the system quote or the was-price check over HTTP', async () => {
    await boot();
    for (const path of ['/promotions/quote', '/promotions/seller/quote', '/promotions/was-price']) {
      const answer = await http().post(path).set({ 'x-market-id': code }).send({});
      expect(answer.status).toBe(404);
    }
  });
});
