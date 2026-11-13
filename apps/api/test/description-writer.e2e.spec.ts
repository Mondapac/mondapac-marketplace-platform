import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { AdminAiModelSetup } from '../src/modules/catalog/application/use-cases/admin-ai-model-setup.use-case';
import { AdminDescriptionDraft } from '../src/modules/catalog/application/use-cases/admin-description-draft.use-case';
import { AdminDescriptionWriterStatus } from '../src/modules/catalog/application/use-cases/admin-description-writer-status.use-case';
import { OwnDescriptionDraft } from '../src/modules/catalog/application/use-cases/own-description-draft.use-case';
import { OwnDescriptionWriterStatus } from '../src/modules/catalog/application/use-cases/own-description-writer-status.use-case';
import { DESCRIPTION_WRITER_STATUS } from '../src/modules/catalog/presentation/description-writer.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The AI description writer routes over HTTP (Hassan L3): the real guards and controllers with the
// use cases stubbed, so this proves the panel population of each route, Origin and CSRF, JSON
// only, the status of every refusal with Retry-After and the allowed details, `no-store`, and
// that no field of a refusal other than the allowed details reaches the client. The flow has its
// own spec (description-writer.flow.spec.ts).

const START = Temporal.Instant.from('2026-11-13T10:00:00Z');
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
const OWN = '/catalog/own/description-writer';
const ADMIN_ROUTE = '/catalog/admin/description-writer';
const BODY = { title: 'Sella basmati rice', category: 'Basmati rice', keywords: ['biryani'] };
const DRAFT = {
  text: 'Firm grains for biryani.',
  leftOut: { certification: 1, other: 0 },
  promptVersion: 'description-writer-1',
};

it('maps every refusal code of the writer routes to its exact status', () => {
  expect(DESCRIPTION_WRITER_STATUS).toEqual({
    'validation.failed': 400,
    'access.denied': 403,
    'access.acting-as-refused': 403,
    'ai.writer-off': 409,
    'ai.draft-withheld': 422,
    'ai.limit-reached': 429,
    'request.throttled': 429,
    'access.unavailable': 503,
    'ai.writer-failed': 503,
  });
});

describe.each(TEST_MARKETS)('description writer over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  const stub = (name: string) => ({
    execute: (_context: unknown, input: unknown) => {
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
          .overrideProvider(OwnDescriptionWriterStatus)
          .useValue(stub('own-status'))
          .overrideProvider(OwnDescriptionDraft)
          .useValue(stub('own-draft'))
          .overrideProvider(AdminDescriptionWriterStatus)
          .useValue(stub('admin-status'))
          .overrideProvider(AdminDescriptionDraft)
          .useValue(stub('admin-draft'))
          .overrideProvider(AdminAiModelSetup)
          .useValue(stub('model-setup')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'writer-seed-01'), {});
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
  }

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
    method: 'get' | 'put',
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
    next = ok(DRAFT);
  });
  afterEach(async () => {
    await app?.close();
  });

  const post = (
    path: string,
    population: 'seller' | 'admin',
    headers: Record<string, string>,
    payload: unknown = BODY,
  ) =>
    http()
      .post(`${path}/drafts`)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers })
      .send(payload as object);

  it('drafts for a seller and an admin on their own routes, passing the body as sent', async () => {
    await boot();
    const seller = await post(OWN, 'seller', sessionOf('seller', 1));
    expect(seller.status).toBe(200);
    expect(seller.headers['cache-control']).toBe('no-store');
    expect(seller.body).toEqual(DRAFT);
    const admin = await post(ADMIN_ROUTE, 'admin', sessionOf('admin', 2));
    expect(admin.status).toBe(200);
    expect(calls).toEqual([
      { name: 'own-draft', input: { body: BODY } },
      { name: 'admin-draft', input: { body: BODY } },
    ]);
  });

  it('answers the status and the model setup on GET, with no-store', async () => {
    await boot();
    next = ok({ available: true, resetZone: 'Etc/UTC' });
    const own = await call('get', OWN, 'seller', sessionOf('seller', 3));
    expect(own.status).toBe(200);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(own.body).toEqual({ available: true, resetZone: 'Etc/UTC' });
    next = ok({ killSwitch: false, keyConfigured: true, models: { fast: 'm', balanced: null } });
    const setup = await call('get', `${ADMIN_ROUTE}/model-setup`, 'admin', sessionOf('admin', 4));
    expect(setup.status).toBe(200);
    expect(setup.body).toEqual({
      killSwitch: false,
      keyConfigured: true,
      models: { fast: 'm', balanced: null },
    });
  });

  it('keeps each population on its own route: the other one never reaches a use case', async () => {
    await boot();
    const sellerOnAdmin = await post(ADMIN_ROUTE, 'seller', sessionOf('seller', 5));
    const adminOnOwn = await post(OWN, 'admin', sessionOf('admin', 6));
    expect(sellerOnAdmin.status).toBeGreaterThanOrEqual(400);
    expect(adminOnOwn.status).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
  });

  it('refuses a draft without the CSRF token, and a body that is not JSON', async () => {
    await boot();
    const session = sessionOf('seller', 7);
    const noCsrf = await post(OWN, 'seller', { cookie: session.cookie });
    expect(noCsrf.status).toBe(403);
    const text = await http()
      .post(`${OWN}/drafts`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
      .set('content-type', 'text/plain')
      .send('title=Rice');
    expect(text.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it.each([
    ['validation.failed', { fields: [{ path: 'note', code: 'too-long' }] }, 400],
    ['access.acting-as-refused', {}, 403],
    ['ai.writer-off', {}, 409],
    ['ai.draft-withheld', { leftOut: { certification: 2, other: 1 } }, 422],
    ['request.throttled', { retryAfterSeconds: 30 }, 429],
    ['access.unavailable', {}, 503],
    ['ai.writer-failed', {}, 503],
  ] as const)('answers %s with %j as %i', async (refusal, extra, status) => {
    await boot();
    next = err({ code: refusal, ...extra });
    const answer = await post(OWN, 'seller', sessionOf('seller', 8));
    expect(answer.status).toBe(status);
    expect(answer.body).toEqual({
      statusCode: status,
      code: refusal,
      ...(Object.keys(extra).length > 0 ? { details: extra } : {}),
    });
  });

  it('answers ai.limit-reached with Retry-After and the reset zone, and nothing else', async () => {
    await boot();
    next = err({
      code: 'ai.limit-reached',
      retryAfterSeconds: 14400,
      resetZone: 'Australia/Brisbane',
      providerText: 'secret model output',
    });
    const answer = await post(ADMIN_ROUTE, 'admin', sessionOf('admin', 9));
    expect(answer.status).toBe(429);
    expect(answer.headers['retry-after']).toBe('14400');
    expect(answer.body).toEqual({
      statusCode: 429,
      code: 'ai.limit-reached',
      details: { retryAfterSeconds: 14400, resetZone: 'Australia/Brisbane' },
    });
    expect(JSON.stringify(answer.body)).not.toContain('secret');
  });
});
