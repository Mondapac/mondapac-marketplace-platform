import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { SetAssistantSettings } from '../src/modules/assistant/application/use-cases/set-assistant-settings.use-case';
import { ViewAssistantSettings } from '../src/modules/assistant/application/use-cases/view-assistant-settings.use-case';
import { ViewStorefrontAssistant } from '../src/modules/assistant/application/use-cases/view-storefront-assistant.use-case';
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/modules/assistant/domain/assistant-settings';
import { ASSISTANT_STATUS } from '../src/modules/assistant/presentation/http-answers';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The buyer assistant settings routes over HTTP: the real guards and controllers; the use cases
// are stubs, so this proves the session, the admin population, Origin and CSRF, the closed body
// (top level and settings), the status of each refusal, the answer shape and `no-store`, and that
// the storefront read takes no session. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-19T21:00:00Z');
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
const PATH = '/assistant/admin/settings';
const PUBLIC = '/assistant/storefront';
const VIEW = {
  version: 2,
  settings: DEFAULT_ASSISTANT_SETTINGS,
  apiKey: 'not-set',
  models: [
    { tier: 'fast', modelId: null },
    { tier: 'balanced', modelId: null },
  ],
  unavailableOptions: { scope: ['cart-suggestions'], supportHandoff: ['in-panel-form'] },
};
const STOREFRONT = {
  enabled: true,
  guestsAllowed: true,
  replyLanguage: 'buyer',
  welcomeText: 'Hi',
};

it('maps every refusal code of the assistant routes to its exact status', () => {
  expect(ASSISTANT_STATUS).toEqual({ 'validation.failed': 400, 'assistant.conflict': 409 });
});

describe.each(TEST_MARKETS)('assistant settings over HTTP in market %s', (code) => {
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
          .overrideProvider(ViewAssistantSettings)
          .useValue(stub('view'))
          .overrideProvider(SetAssistantSettings)
          .useValue(stub('set'))
          .overrideProvider(ViewStorefrontAssistant)
          .useValue(stub('public')),
    }));
    await app
      .get(SeedRoles)
      .execute(testCallContext(marketOf(), 'system', 'assistant-seed-01'), {});
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
    population: 'seller' | 'admin',
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](PATH)
      .set({ 'x-market-id': code, ...panelHeaders(code, population), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    actorKinds = [];
    next = ok(VIEW);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read and replace the settings, passing them to the use case', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    const read = await call('get', 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual(VIEW);

    const settings = { ...DEFAULT_ASSISTANT_SETTINGS, enabled: true };
    const set = await call('put', 'admin', session, { expectedVersion: 2, settings });
    expect(set.status).toBe(200);
    expect(set.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([
      { name: 'view', input: {} },
      { name: 'set', input: { settings, expectedVersion: 2 } },
    ]);
  });

  it('never answers the API key itself', async () => {
    await boot();
    const read = await call('get', 'admin', sessionOf('admin', 2));
    expect(Object.keys(read.body as object).sort()).toEqual([
      'apiKey',
      'models',
      'settings',
      'unavailableOptions',
      'version',
    ]);
    expect(['set', 'not-set']).toContain((read.body as { apiKey: string }).apiKey);
  });

  it('reads only the admin session: without one, or with a seller cookie, the gate sees an anonymous actor', async () => {
    await boot();
    await call('get', 'admin', {});
    await http()
      .get(PATH)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...sessionOf('seller', 4) });
    await call('get', 'admin', sessionOf('admin', 5));
    // The real gate refuses the anonymous actor (access.unauthenticated); the stub only records it.
    expect(actorKinds).toEqual(['anonymous', 'anonymous', 'authenticated']);
  });

  it('refuses a change from a foreign Origin or a cross-site fetch', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const settings = { ...DEFAULT_ASSISTANT_SETTINGS };
    const foreign = await http()
      .put(PATH)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        origin: 'https://evil.example',
      })
      .send({ expectedVersion: 0, settings });
    expect(foreign.status).toBe(403);
    const crossSite = await http()
      .put(PATH)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...session,
        'sec-fetch-site': 'cross-site',
      })
      .send({ expectedVersion: 0, settings });
    expect(crossSite.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('answers the storefront read with no session, passing only the visitor key', async () => {
    await boot();
    next = ok(STOREFRONT);
    const read = await http()
      .get(PUBLIC)
      .query({ visitor: 'visitor-key-0123456789' })
      .set({ 'x-market-id': code, cookie: sessionOf('admin', 3).cookie });
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.headers['set-cookie']).toBeUndefined();
    expect(read.body).toEqual(STOREFRONT);
    expect(calls).toEqual([{ name: 'public', input: { visitor: 'visitor-key-0123456789' } }]);
    expect(actorKinds).toEqual(['anonymous']);
  });

  it('refuses the storefront read without a Market header', async () => {
    await boot();
    expect((await http().get(PUBLIC)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses a change without CSRF, with a stray field at either level and not as JSON', async () => {
    await boot();
    const session = sessionOf('admin', 2);
    const settings = { ...DEFAULT_ASSISTANT_SETTINGS };

    expect(
      (await call('put', 'admin', { cookie: session.cookie }, { expectedVersion: 0, settings }))
        .status,
    ).toBe(403);
    const extra = await call('put', 'admin', session, { expectedVersion: 0, settings, x: 1 });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'x', code: 'unknown-field' }] },
    });
    const nested = await call('put', 'admin', session, {
      expectedVersion: 0,
      settings: { ...settings, apiKey: 'sk-x' },
    });
    expect(nested.status).toBe(400);
    expect(nested.body).toMatchObject({
      details: { fields: [{ path: 'settings.apiKey', code: 'unknown-field' }] },
    });
    const notObject = await call('put', 'admin', session, { expectedVersion: 0, settings: [] });
    expect(notObject.status).toBe(400);
    expect(notObject.body).toMatchObject({
      details: { fields: [{ path: 'settings', code: 'type' }] },
    });
    const text = await http()
      .put(PATH)
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
      call('put', 'admin', session, { expectedVersion: 0, settings: DEFAULT_ASSISTANT_SETTINGS });

    next = err({ code: 'validation.failed', fields: [{ path: 'scope', code: 'unavailable' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      details: { fields: [{ path: 'scope', code: 'unavailable' }] },
    });
    next = err({ code: 'assistant.conflict' });
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ statusCode: 409, code: 'assistant.conflict' });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
  });
});
