import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ChangeCartModeSetting } from '../src/modules/settings/application/use-cases/change-cart-mode-setting.use-case';
import { ChangeListPagingSetting } from '../src/modules/settings/application/use-cases/change-list-paging-setting.use-case';
import { ChangeOfferReviewSettings } from '../src/modules/settings/application/use-cases/change-offer-review-settings.use-case';
import { ViewOfferReviewSettings } from '../src/modules/settings/application/use-cases/view-offer-review-settings.use-case';
import { ChangeOfferReviewEmergencyStop } from '../src/modules/settings/application/use-cases/change-offer-review-emergency-stop.use-case';
import { ViewOfferReviewEmergencyStop } from '../src/modules/settings/application/use-cases/view-offer-review-emergency-stop.use-case';
import { ReadListPaging } from '../src/modules/settings/application/use-cases/read-list-paging.use-case';
import { ViewCartModeSetting } from '../src/modules/settings/application/use-cases/view-cart-mode-setting.use-case';
import { ChangeMonthlyRevenueTargetSetting } from '../src/modules/settings/application/use-cases/change-monthly-revenue-target-setting.use-case';
import { ViewMonthlyRevenueTargetSetting } from '../src/modules/settings/application/use-cases/view-monthly-revenue-target-setting.use-case';
import { ViewListPagingSetting } from '../src/modules/settings/application/use-cases/view-list-paging-setting.use-case';
import { SETTINGS_STATUS } from '../src/modules/settings/presentation/http-answers';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { ViewAiGatewaySettings } from '../src/modules/settings/application/use-cases/view-ai-gateway-settings.use-case';
import { ChangeAiGatewayLimits } from '../src/modules/settings/application/use-cases/change-ai-gateway-limits.use-case';
import { ChangeAiGatewayEmergencyStop } from '../src/modules/settings/application/use-cases/change-ai-gateway-emergency-stop.use-case';
import { ChangeAiCapabilities } from '../src/modules/settings/application/use-cases/change-ai-capabilities.use-case';
import { RevertAiGatewaySetting } from '../src/modules/settings/application/use-cases/revert-ai-gateway-setting.use-case';
import { RevertAiModelsSetting } from '../src/modules/settings/application/use-cases/revert-ai-models-setting.use-case';
import { ViewAiGatewayHistory } from '../src/modules/settings/application/use-cases/view-ai-gateway-history.use-case';
import { ViewAiModelsHistory } from '../src/modules/settings/application/use-cases/view-ai-models-history.use-case';
import { panelHeaders, TEST_MARKETS } from './support/test-config';
import { ViewAiEvaluations } from '../src/modules/settings/application/use-cases/view-ai-evaluations.use-case';
import { ViewAiEvaluation } from '../src/modules/settings/application/use-cases/view-ai-evaluation.use-case';
import { EstimateAiEvaluation } from '../src/modules/settings/application/use-cases/estimate-ai-evaluation.use-case';
import { RunAiEvaluation } from '../src/modules/settings/application/use-cases/run-ai-evaluation.use-case';
import { CancelAiEvaluation } from '../src/modules/settings/application/use-cases/cancel-ai-evaluation.use-case';
import { ViewAiPlaygroundSamples } from '../src/modules/settings/application/use-cases/view-ai-playground-samples.use-case';
import { RunAiPlayground } from '../src/modules/settings/application/use-cases/run-ai-playground.use-case';
import { ViewAiModelUsage } from '../src/modules/settings/application/use-cases/view-ai-model-usage.use-case';

// The settings routes over HTTP: the real guards and controllers; the use cases are stubs, so this
// proves the session, the panel population, Origin and CSRF, the closed body, the status of each
// refusal, the answer shape and `no-store`, and the two panel reads of List paging. The use cases
// have their own spec (settings-use-cases.spec.ts) and the store its own database spec.

const START = Temporal.Instant.from('2026-11-03T21:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const SELLER_ACCOUNT = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const SETTINGS = '/settings/admin/market-settings';
const ADMIN_PAGING = '/settings/admin/list-paging';
const SELLER_PAGING = '/settings/seller/list-paging';
const NOT_REVIEWED = { reviewed: false, risk: 'low' } as const;
const LIST = [
  { code: 'list-paging', value: 'pages', version: 0, updatedAt: null, review: NOT_REVIEWED },
];
const CHANGED = {
  code: 'list-paging',
  value: 'prev-next',
  version: 1,
  updatedAt: START.toString(),
  review: { reviewed: true, risk: 'medium' },
  request: { id: id<'SystemRequest'>(0x5e01), number: 12 },
};

it('maps every refusal code of the settings routes to its exact status', () => {
  expect(SETTINGS_STATUS).toEqual({
    'validation.failed': 400,
    'settings.conflict': 409,
    'second-factor.required': 403,
    'second-factor.enrolment-required': 403,
    'ai.evaluation-not-found': 404,
    'ai.playground-limit-reached': 429,
  });
});

describe.each(TEST_MARKETS)('settings over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  let actorKinds: string[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (context: { actor: { kind: string } }, input: unknown) => {
      calls.push({ name, input });
      actorKinds.push(context.actor.kind);
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
          .overrideProvider(ViewListPagingSetting)
          .useValue(stub('view'))
          .overrideProvider(ChangeListPagingSetting)
          .useValue(stub('change'))
          .overrideProvider(ReadListPaging)
          .useValue(stub('paging'))
          .overrideProvider(ViewCartModeSetting)
          .useValue(stub('view-cart'))
          .overrideProvider(ChangeCartModeSetting)
          .useValue(stub('change-cart'))
          .overrideProvider(ViewMonthlyRevenueTargetSetting)
          .useValue(stub('view-target'))
          .overrideProvider(ChangeMonthlyRevenueTargetSetting)
          .useValue(stub('change-target'))
          .overrideProvider(ViewOfferReviewSettings)
          .useValue(stub('view-offer-review'))
          .overrideProvider(ChangeOfferReviewSettings)
          .useValue(stub('change-offer-review'))
          .overrideProvider(ViewOfferReviewEmergencyStop)
          .useValue(stub('view-stop'))
          .overrideProvider(ChangeOfferReviewEmergencyStop)
          .useValue(stub('change-stop'))
          .overrideProvider(ViewAiGatewaySettings)
          .useValue(stub('view-ai-gateway'))
          .overrideProvider(ChangeAiGatewayLimits)
          .useValue(stub('change-ai-limits'))
          .overrideProvider(ChangeAiGatewayEmergencyStop)
          .useValue(stub('change-ai-stop'))
          .overrideProvider(ChangeAiCapabilities)
          .useValue(stub('change-ai-capabilities'))
          .overrideProvider(ViewAiGatewayHistory)
          .useValue(stub('ai-gateway-history'))
          .overrideProvider(ViewAiModelsHistory)
          .useValue(stub('ai-models-history'))
          .overrideProvider(RevertAiGatewaySetting)
          .useValue(stub('revert-ai-gateway'))
          .overrideProvider(RevertAiModelsSetting)
          .useValue(stub('revert-ai-models'))
          .overrideProvider(ViewAiEvaluations)
          .useValue(stub('view-evaluations'))
          .overrideProvider(ViewAiEvaluation)
          .useValue(stub('view-evaluation'))
          .overrideProvider(EstimateAiEvaluation)
          .useValue(stub('estimate-evaluation'))
          .overrideProvider(RunAiEvaluation)
          .useValue(stub('run-evaluation'))
          .overrideProvider(CancelAiEvaluation)
          .useValue(stub('cancel-evaluation'))
          .overrideProvider(ViewAiPlaygroundSamples)
          .useValue(stub('view-playground-samples'))
          .overrideProvider(RunAiPlayground)
          .useValue(stub('run-playground'))
          .overrideProvider(ViewAiModelUsage)
          .useValue(stub('view-model-usage')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'settings-seed-01'), {});
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
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: SELLER_ACCOUNT,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
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
    fakes.factors.set(ADMIN, {
      id: id<'SecondFactor'>(0xf309),
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
  }
  /** A fresh step-up proof of the admin session n for one settings action. */
  const prove = (n: number, action: string) =>
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf100 + n)}|${action}`, clock.now());

  function sessionOf(population: 'seller' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'seller' ? SELLER_ACCOUNT : ADMIN,
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

  const call = (
    method: 'get' | 'put' | 'post',
    path: string,
    population: 'seller' | 'admin',
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    actorKinds = [];
    next = ok(LIST);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read the settings and change one, passing the body to the use case', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    const read = await call('get', SETTINGS, 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      settings: [
        { code: 'list-paging', value: 'pages', version: 0, updatedAt: null, review: NOT_REVIEWED },
      ],
    });

    next = ok(CHANGED);
    const set = await call('put', SETTINGS, 'admin', session, {
      code: 'list-paging',
      value: 'prev-next',
      expectedVersion: 0,
      note: 'Shorter pages for phones',
    });
    expect(set.status).toBe(200);
    expect(set.headers['cache-control']).toBe('no-store');
    // The request the change opened in System requests comes back with the setting.
    expect(set.body).toEqual(CHANGED);
    expect(calls).toEqual([
      { name: 'view', input: {} },
      {
        name: 'change',
        input: {
          code: 'list-paging',
          value: 'prev-next',
          expectedVersion: 0,
          note: 'Shorter pages for phones',
        },
      },
    ]);
  });

  it('reads and changes Cart mode on its own route, the code coming from the route', async () => {
    await boot();
    const session = sessionOf('admin', 3);
    const cart = '/settings/admin/cart-mode';
    next = ok([
      {
        code: 'cart-mode',
        value: 'multi-store',
        version: 0,
        updatedAt: null,
        review: NOT_REVIEWED,
      },
    ]);
    const read = await call('get', cart, 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      code: 'cart-mode',
      value: 'multi-store',
      version: 0,
      updatedAt: null,
      review: NOT_REVIEWED,
    });

    next = ok({
      code: 'cart-mode',
      value: 'single-store',
      version: 1,
      updatedAt: START.toString(),
      review: NOT_REVIEWED,
      request: null,
    });
    const set = await call('put', cart, 'admin', session, {
      value: 'single-store',
      expectedVersion: 0,
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ value: 'single-store', request: null });
    // A stray `code` field is refused: the route fixes the setting.
    const stray = await call('put', cart, 'admin', session, {
      code: 'list-paging',
      value: 'pages',
      expectedVersion: 0,
    });
    expect(stray.status).toBe(400);
    expect(calls).toEqual([
      { name: 'view-cart', input: {} },
      {
        name: 'change-cart',
        input: { code: 'cart-mode', value: 'single-store', expectedVersion: 0 },
      },
    ]);
  });

  it('reads and sets the monthly revenue target as money, the amount a string of minor units', async () => {
    await boot();
    const session = sessionOf('admin', 3);
    const route = '/settings/admin/monthly-revenue-target';
    next = ok([
      {
        code: 'monthly-revenue-target',
        value: 'none',
        version: 0,
        updatedAt: null,
        review: NOT_REVIEWED,
      },
    ]);
    const empty = await call('get', route, 'admin', session);
    expect(empty.status).toBe(200);
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.body).toEqual({ target: null, version: 0, updatedAt: null, review: NOT_REVIEWED });
    next = ok({
      code: 'monthly-revenue-target',
      value: 'JPY:24000000',
      version: 1,
      updatedAt: START,
      review: NOT_REVIEWED,
      request: null,
    });
    const target = { amount: '24000000', currency: 'JPY' };
    const set = await call('put', route, 'admin', session, { target, expectedVersion: 0 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      target: { amount: '24000000', currency: 'JPY' },
      version: 1,
      updatedAt: START.toString(),
      review: NOT_REVIEWED,
      request: null,
    });
    const stray = await call('put', route, 'admin', session, { value: 'none', expectedVersion: 0 });
    expect(stray.status).toBe(400);
    next = err({ code: 'validation.failed', fields: [{ path: 'target.currency', code: 'value' }] });
    const refused = await call('put', route, 'admin', session, { target, expectedVersion: 0 });
    expect(refused.status).toBe(400);
    expect(calls).toEqual([
      { name: 'view-target', input: {} },
      { name: 'change-target', input: { target, expectedVersion: 0, note: undefined } },
      { name: 'change-target', input: { target, expectedVersion: 0, note: undefined } },
    ]);
  });

  it('answers List paging to a signed-in admin and to a signed-in seller, each on its own route', async () => {
    await boot();
    next = ok('pages');

    const admin = await call('get', ADMIN_PAGING, 'admin', sessionOf('admin', 2));
    const seller = await call('get', SELLER_PAGING, 'seller', sessionOf('seller', 3));

    expect(admin.status).toBe(200);
    expect(seller.status).toBe(200);
    expect(admin.headers['cache-control']).toBe('no-store');
    expect(seller.headers['cache-control']).toBe('no-store');
    expect(admin.body).toEqual({ listPaging: 'pages' });
    expect(seller.body).toEqual({ listPaging: 'pages' });
    expect(actorKinds).toEqual(['authenticated', 'authenticated']);
  });

  it('reads only the right population: no session or the other panel session is an anonymous actor', async () => {
    await boot();
    await call('get', ADMIN_PAGING, 'admin', {});
    await call('get', SELLER_PAGING, 'seller', {});
    await http()
      .get(ADMIN_PAGING)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...sessionOf('seller', 4) });
    // The real gate refuses the anonymous actor (access.unauthenticated); the stub only records it.
    expect(actorKinds).toEqual(['anonymous', 'anonymous', 'anonymous']);
  });

  it('refuses a change from a foreign Origin or a cross-site fetch', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const body = { code: 'list-paging', value: 'pages', expectedVersion: 0 };
    const foreign = await http()
      .put(SETTINGS)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        origin: 'https://evil.example',
      })
      .send(body);
    const crossSite = await http()
      .put(SETTINGS)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        'sec-fetch-site': 'cross-site',
      })
      .send(body);
    expect(foreign.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses a change without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const body = { code: 'list-paging', value: 'pages', expectedVersion: 0 };

    expect((await call('put', SETTINGS, 'admin', { cookie: session.cookie }, body)).status).toBe(
      403,
    );
    const extra = await call('put', SETTINGS, 'admin', session, { ...body, updatedBy: 'x' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'updatedBy', code: 'unknown-field' }] },
    });
    const text = await http()
      .put(SETTINGS)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('maps invalid, conflict and denied', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const put = () =>
      call('put', SETTINGS, 'admin', session, {
        code: 'list-paging',
        value: 'pages',
        expectedVersion: 0,
      });

    next = err({ code: 'validation.failed', fields: [{ path: 'value', code: 'value' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ details: { fields: [{ path: 'value', code: 'value' }] } });
    next = err({ code: 'settings.conflict' });
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ statusCode: 409, code: 'settings.conflict' });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
  });
  it('reads and saves the Offer review policy as one list, all or nothing', async () => {
    await boot();
    const session = sessionOf('admin', 4);
    const path = '/settings/admin/offer-review';
    const row = { code: 'offer-review-sampling', value: '5', version: 0, updatedAt: null };
    next = ok([{ ...row, review: NOT_REVIEWED }]);
    const read = await call('get', path, 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({ settings: [{ ...row, review: NOT_REVIEWED }] });

    const changes = [{ code: 'offer-review-sampling', value: '10', expectedVersion: 0 }];
    next = ok([
      {
        ...row,
        value: '10',
        version: 1,
        updatedAt: START,
        review: NOT_REVIEWED,
        request: null,
      },
    ]);
    const noCode = await call('put', path, 'admin', session, { changes, note: 'Launch' });
    expect(noCode.status).toBe(403);
    expect(noCode.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'settings.offer-review.change' },
    });
    prove(4, 'settings.offer-review.change');
    const set = await call('put', path, 'admin', session, { changes, note: 'Launch' });
    expect(set.status).toBe(200);
    expect(set.headers['cache-control']).toBe('no-store');
    expect(set.body).toEqual({
      settings: [
        {
          ...row,
          value: '10',
          version: 1,
          updatedAt: START.toString(),
          review: NOT_REVIEWED,
          request: null,
        },
      ],
    });
    // The body is closed: a stray field never reaches the use case.
    const stray = await call('put', path, 'admin', session, { changes, code: 'list-paging' });
    expect(stray.status).toBe(400);
    // No CSRF token: refused before the use case.
    expect((await call('put', path, 'admin', { cookie: session.cookie }, { changes })).status).toBe(
      403,
    );
    next = err({ code: 'settings.conflict' });
    const conflict = await call('put', path, 'admin', session, { changes });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ statusCode: 409, code: 'settings.conflict' });
    next = err({ code: 'access.denied' });
    expect((await call('put', path, 'admin', session, { changes })).status).toBe(403);
    expect(calls.map((c) => c.name)).toEqual([
      'view-offer-review',
      'change-offer-review',
      'change-offer-review',
      'change-offer-review',
    ]);
    expect(calls[1]?.input).toEqual({ changes, note: 'Launch' });
  });
  it('reads the emergency stop for the banner and switches it with a closed body', async () => {
    await boot();
    const session = sessionOf('admin', 5);
    const path = '/settings/admin/offer-review/emergency-stop';
    next = ok({ on: true, version: 1, changedAt: START, changedBy: 'Leila Admin' });
    const read = await call('get', path, 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({
      on: true,
      version: 1,
      changedAt: START.toString(),
      changedBy: 'Leila Admin',
    });
    const body = { value: 'off', expectedVersion: 1, note: 'All clear' };
    next = ok([]);
    const noCode = await call('put', path, 'admin', session, body);
    expect(noCode.status).toBe(403);
    expect(noCode.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'settings.offer-review-emergency-stop.change' },
    });
    prove(5, 'settings.offer-review-emergency-stop.change');
    const set = await call('put', path, 'admin', session, body);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ settings: [] });
    expect((await call('put', path, 'admin', session, { ...body, code: 'x' })).status).toBe(400);
    expect((await call('put', path, 'admin', { cookie: session.cookie }, body)).status).toBe(403);
    next = err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] });
    expect((await call('put', path, 'admin', session, { ...body, note: '' })).status).toBe(400);
    expect(calls.map((c) => c.name)).toEqual(['view-stop', 'change-stop', 'change-stop']);
    expect(calls[1]?.input).toEqual(body);
  });

  it('reads the AI Gateway settings and saves the caps and the AI stop with closed bodies (G4a)', async () => {
    await boot();
    const session = sessionOf('admin', 6);
    const read = await call('get', '/settings/admin/ai-gateway', 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');

    const limits = '/settings/admin/ai-gateway/limits';
    const caps = {
      changes: [{ code: 'ai-cap-market-day', value: '5000000', expectedVersion: 0 }],
      note: 'Raise for launch',
    };
    // The use case decides the step-up (only a raise asks); its refusal maps to 403 with the key.
    next = err({ code: 'second-factor.required', actionKey: 'settings.ai-gateway-limits.raise' });
    const noCode = await call('put', limits, 'admin', session, caps);
    expect(noCode.status).toBe(403);
    expect(noCode.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'settings.ai-gateway-limits.raise' },
    });
    next = ok([]);
    expect((await call('put', limits, 'admin', session, caps)).status).toBe(200);
    next = err({ code: 'settings.conflict' });
    expect((await call('put', limits, 'admin', session, caps)).status).toBe(409);
    expect((await call('put', limits, 'admin', session, { ...caps, extra: 1 })).status).toBe(400);
    expect((await call('put', limits, 'admin', { cookie: session.cookie }, caps)).status).toBe(403);

    const stop = '/settings/admin/ai-gateway/emergency-stop';
    const body = { value: 'on', expectedVersion: 0, note: 'Leak suspected' };
    next = ok([]);
    expect((await call('put', stop, 'admin', session, body)).status).toBe(200);
    expect((await call('put', stop, 'admin', session, { ...body, code: 'x' })).status).toBe(400);
    expect((await call('put', stop, 'admin', { cookie: session.cookie }, body)).status).toBe(403);
    // A seller session never reaches the admin routes.
    expect(
      (await call('put', stop, 'seller', sessionOf('seller', 7), body)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(calls.map((c) => c.name)).toEqual([
      'view-ai-gateway',
      'change-ai-limits',
      'change-ai-limits',
      'change-ai-limits',
      'change-ai-stop',
    ]);
    expect(calls[1]?.input).toEqual(caps);
    expect(calls[4]?.input).toEqual(body);
  });
  it('switches capabilities, reads a setting history and reverts it with closed bodies (G4d3)', async () => {
    await boot();
    const session = sessionOf('admin', 9);
    const switches = '/settings/admin/ai-gateway/capabilities';
    const body = {
      changes: [{ code: 'ai-capability-assistant-buyer-chat', value: 'on', expectedVersion: 1 }],
    };
    next = err({ code: 'second-factor.required', actionKey: 'settings.ai-capability.resume' });
    const noCode = await call('put', switches, 'admin', session, body);
    expect(noCode.status).toBe(403);
    expect(noCode.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'settings.ai-capability.resume' },
    });
    next = ok([]);
    expect((await call('put', switches, 'admin', session, body)).status).toBe(200);
    expect((await call('put', switches, 'admin', session, { ...body, value: 'on' })).status).toBe(
      400,
    );

    const at = START;
    next = ok([
      {
        code: 'ai-cap-market-day',
        version: 2,
        previousValue: 'none',
        value: '100',
        changedAt: at,
        changedBy: null,
        note: null,
        current: true,
      },
    ]);
    const history = await call(
      'get',
      '/settings/admin/ai-gateway/history?code=ai-cap-market-day&limit=10',
      'admin',
      session,
    );
    expect(history.status).toBe(200);
    expect(history.headers['cache-control']).toBe('no-store');
    expect(history.body).toEqual({
      history: [
        {
          code: 'ai-cap-market-day',
          version: 2,
          previousValue: 'none',
          value: '100',
          changedAt: at.toString(),
          changedBy: null,
          note: null,
          current: true,
        },
      ],
    });
    next = ok([]);
    expect(
      (await call('get', '/settings/admin/ai-models/history?code=ai-models-chat', 'admin', session))
        .status,
    ).toBe(200);

    const revert = { code: 'ai-cap-market-day', version: 1, expectedVersion: 2 };
    next = err({ code: 'second-factor.required', actionKey: 'settings.ai-settings.revert' });
    expect(
      (await call('post', '/settings/admin/ai-gateway/revert', 'admin', session, revert)).status,
    ).toBe(403);
    next = ok({ ...CHANGED, updatedAt: START });
    const done = await call('post', '/settings/admin/ai-gateway/revert', 'admin', session, revert);
    expect(done.status).toBe(200);
    next = err({ code: 'settings.conflict' });
    expect(
      (await call('post', '/settings/admin/ai-models/revert', 'admin', session, revert)).status,
    ).toBe(409);
    expect(
      (
        await call('post', '/settings/admin/ai-gateway/revert', 'admin', session, {
          ...revert,
          x: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'post',
          '/settings/admin/ai-gateway/revert',
          'admin',
          { cookie: session.cookie },
          revert,
        )
      ).status,
    ).toBe(403);
    expect(calls.map((c) => c.name)).toEqual([
      'change-ai-capabilities',
      'change-ai-capabilities',
      'ai-gateway-history',
      'ai-models-history',
      'revert-ai-gateway',
      'revert-ai-gateway',
      'revert-ai-models',
    ]);
    expect(calls[2]?.input).toEqual({ code: 'ai-cap-market-day', limit: 10 });
    expect(calls[3]?.input).toEqual({ code: 'ai-models-chat', limit: undefined });
    expect(calls[4]?.input).toEqual({ ...revert, note: undefined });
  });

  it('serves the AI evaluation runs and the playground (G4c): step-up on a run, closed bodies', async () => {
    await boot();
    const session = sessionOf('admin', 8);
    const base = '/settings/admin/ai-models';
    const runId = id<'AiEvaluationRun'>(0xe7a1);
    const estimate = {
      provider: 'anthropic',
      family: 'model-fast',
      capabilities: [
        {
          capability: 'catalog.description-writer.admin',
          promptVersion: 'p-1',
          setVersion: 'p-1',
          samples: 2,
          estimateMicroUsd: 900,
        },
      ],
      estimateMicroUsd: 900,
      budgetLeftMicroUsd: 10_000,
      blockers: [],
    };
    const run = {
      id: runId,
      provider: 'anthropic',
      family: 'model-fast',
      status: 'queued',
      requestedBy: ADMIN,
      requestedAt: START,
      estimateMicroUsd: 900,
      startedAt: null,
      endedAt: null,
    };

    next = ok({ runs: [run], next: null });
    const list = await call('get', `${base}/evaluations?family=model-fast`, 'admin', session);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({ runs: [{ ...run, requestedAt: START.toString() }], next: null });

    next = ok(estimate);
    const estimated = await call(
      'get',
      `${base}/evaluations/estimate?provider=anthropic&family=model-fast`,
      'admin',
      session,
    );
    expect(estimated.status).toBe(200);
    expect(estimated.body).toEqual(estimate);

    next = ok({ run, capabilities: [], samples: [], costMicroUsd: 0 });
    expect((await call('get', `${base}/evaluations/${runId}`, 'admin', session)).status).toBe(200);
    next = err({ code: 'ai.evaluation-not-found' });
    const missing = await call('get', `${base}/evaluations/${runId}`, 'admin', session);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, code: 'ai.evaluation-not-found' });

    // A run asks a fresh two-step code first: the guard refuses without one.
    const body = { provider: 'anthropic', family: 'model-fast', expectedEstimateMicroUsd: 900 };
    const noCode = await call('post', `${base}/evaluations`, 'admin', session, body);
    expect(noCode.status).toBe(403);
    expect(noCode.body).toMatchObject({
      code: 'second-factor.required',
      details: { actionKey: 'settings.ai-evaluation.run' },
    });
    prove(8, 'settings.ai-evaluation.run');
    next = ok({ runId, estimate });
    const queued = await call('post', `${base}/evaluations`, 'admin', session, body);
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ runId, estimate });
    prove(8, 'settings.ai-evaluation.run');
    expect(
      (await call('post', `${base}/evaluations`, 'admin', session, { ...body, note: 'x' })).status,
    ).toBe(400);
    expect(
      (await call('post', `${base}/evaluations`, 'admin', { cookie: session.cookie }, body)).status,
    ).toBe(403);

    next = ok({ runId });
    const cancelled = await call('post', `${base}/evaluations/${runId}/cancel`, 'admin', session);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ runId });

    // G5e: the usage of the last 30 days, numbers only.
    const usage = {
      from: '2026-10-05',
      to: '2026-11-03',
      days: 30,
      families: [
        {
          family: 'model-fast',
          provider: 'anthropic',
          calls: 1000,
          failures: 20,
          stoodIn: 3,
          costMicroUsd: 4_000_000,
          p95: { bound: 2000, above: false },
          evaluation: { passed: 1, of: 2 },
        },
      ],
      tasks: [
        {
          task: 'write',
          calls: 1000,
          inputTokens: 500_000,
          outputTokens: 200_000,
          costByFamily: [
            { family: 'model-fast', costMicroUsd: 1_500_000 },
            { family: 'model-balanced', costMicroUsd: null },
          ],
        },
      ],
    };
    next = ok(usage);
    const used = await call('get', `${base}/usage`, 'admin', session);
    expect(used.status).toBe(200);
    expect(used.headers['cache-control']).toBe('no-store');
    expect(used.body).toEqual(usage);

    next = ok([{ capability: 'catalog.description-writer.admin', setVersion: 'p-1', samples: [] }]);
    expect((await call('get', `${base}/playground/samples`, 'admin', session)).status).toBe(200);

    const play = {
      capability: 'catalog.description-writer.admin',
      sampleId: 'plain',
      families: ['model-fast', 'model-balanced'],
    };
    const answer = {
      family: 'model-fast',
      outcome: 'ok',
      text: 'Plain text',
      checks: [],
      costMicroUsd: 200,
      latencyMs: 40,
      route: 'anthropic-api',
    };
    next = ok([answer]);
    const played = await call('post', `${base}/playground`, 'admin', session, play);
    expect(played.status).toBe(200);
    expect(played.body).toEqual({ answers: [answer] });
    // Ids only: a prompt or any other field is refused before the use case.
    expect(
      (await call('post', `${base}/playground`, 'admin', session, { ...play, prompt: 'Hi' }))
        .status,
    ).toBe(400);
    next = err({ code: 'ai.playground-limit-reached' });
    const limited = await call('post', `${base}/playground`, 'admin', session, play);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ statusCode: 429, code: 'ai.playground-limit-reached' });
    // A seller session never reaches the admin routes.
    expect(
      (await call('post', `${base}/playground`, 'seller', sessionOf('seller', 9), play)).status,
    ).toBeGreaterThanOrEqual(400);

    expect(calls.map((c) => c.name)).toEqual([
      'view-evaluations',
      'estimate-evaluation',
      'view-evaluation',
      'view-evaluation',
      'run-evaluation',
      'cancel-evaluation',
      'view-model-usage',
      'view-playground-samples',
      'run-playground',
      'run-playground',
    ]);
    expect(calls[0]?.input).toEqual({ family: 'model-fast', cursor: undefined });
    expect(calls[4]?.input).toEqual(body);
    expect(calls[5]?.input).toEqual({ runId });
    expect(calls[8]?.input).toEqual(play);
  });
});
