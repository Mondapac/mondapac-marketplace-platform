import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { RestoreStorefrontSeoSettings } from '../src/modules/storefront/application/use-cases/restore-seo-settings.use-case';
import { SetStorefrontProtectedSeoSettings } from '../src/modules/storefront/application/use-cases/set-protected-seo-settings.use-case';
import { SetStorefrontSeoSettings } from '../src/modules/storefront/application/use-cases/set-seo-settings.use-case';
import { ViewPublicStorefrontSeo } from '../src/modules/storefront/application/use-cases/view-public-seo.use-case';
import { ViewStorefrontSeoSettings } from '../src/modules/storefront/application/use-cases/view-seo-settings.use-case';
import { ViewStorefrontSeoSettingsHistory } from '../src/modules/storefront/application/use-cases/view-seo-settings-history.use-case';
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

// The SEO settings routes over HTTP: the real guards and controllers with stub use cases. This
// proves the admin session, CSRF, the closed bodies, the status of each refusal, the headers and
// that the public read needs no session. The use cases have their own spec.

const START = Temporal.Instant.from('2026-11-11T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xa001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('SEO settings routes over HTTP in market %s', (code) => {
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
          .overrideProvider(ViewStorefrontSeoSettings)
          .useValue(stub('view'))
          .overrideProvider(ViewStorefrontSeoSettingsHistory)
          .useValue(stub('history'))
          .overrideProvider(SetStorefrontSeoSettings)
          .useValue(stub('set'))
          .overrideProvider(SetStorefrontProtectedSeoSettings)
          .useValue(stub('set-protected'))
          .overrideProvider(RestoreStorefrontSeoSettings)
          .useValue(stub('restore'))
          .overrideProvider(ViewPublicStorefrontSeo)
          .useValue(stub('public')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'seo-seed-0001'), {});
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

  function adminSession() {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf101),
        marketId,
        accountId: ADMIN,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const call = (
    method: 'get' | 'post' | 'put',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  const view = {
    version: 3,
    settings: { siteName: 'Shop' },
    sampleDataLock: false,
    envCeiling: 'on',
    lastChanged: null,
  };
  const body = { expectedVersion: 3, settings: { siteName: 'Shop' } };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(view);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read, save, save the protected part, read the history and restore', async () => {
    await boot();
    const session = adminSession();
    const read = await call('get', '/storefront/admin/seo', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect((await call('put', '/storefront/admin/seo', session, body)).status).toBe(200);
    const restore = { expectedVersion: 3, version: 1 };
    expect((await call('post', '/storefront/admin/seo/restore', session, restore)).status).toBe(
      200,
    );
    next = ok({ items: [], next: null });
    expect((await call('get', '/storefront/admin/seo/history?limit=5', session)).status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual(['view', 'set', 'restore', 'history']);
    expect(calls[1]!.input).toEqual({ settings: body.settings, expectedVersion: 3 });
    expect(calls[2]!.input).toEqual({ version: 1, expectedVersion: 3 });
  });

  it('stops the protected save at the guard until the admin has a second factor and a proof', async () => {
    await boot();
    const session = adminSession();
    const res = await call('put', '/storefront/admin/seo/protected', session, body);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'second-factor.enrolment-required',
      details: { actionKey: 'storefront.seo.change-protected' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses a route with no session, a write without CSRF and a stray field', async () => {
    await boot();
    const session = adminSession();
    next = err({ code: 'access.unauthenticated' });
    expect((await call('get', '/storefront/admin/seo', {})).status).toBe(401);
    expect((await call('get', '/storefront/admin/seo/history', {})).status).toBe(401);
    for (const [method, path] of [
      ['put', '/storefront/admin/seo'],
      ['put', '/storefront/admin/seo/protected'],
      ['post', '/storefront/admin/seo/restore'],
    ] as const) {
      expect((await call(method, path, { cookie: session.cookie }, body)).status).toBe(403);
    }
    const extra = await call('put', '/storefront/admin/seo', session, { ...body, version: 1 });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'version', code: 'unknown-field' }] },
    });
    expect(calls.map((c) => c.name)).toEqual(['view', 'history']);
  });

  it('maps the refusals to their status and details', async () => {
    await boot();
    const session = adminSession();
    const save = () => call('put', '/storefront/admin/seo', session, body);
    next = err({ code: 'access.denied' });
    expect((await save()).status).toBe(403);
    next = err({ code: 'validation.failed', fields: [{ path: 'siteName', code: 'required' }] });
    const invalid = await save();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      details: { fields: [{ path: 'siteName', code: 'required' }] },
    });
    next = err({
      code: 'storefront.conflict',
      lastChanged: { version: 4, at: START, by: { displayName: 'Sam' } },
    });
    const conflict = await save();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'storefront.conflict' });
    expect(conflict.body).toHaveProperty('details.lastChanged');
    next = err({ code: 'second-factor.required', actionKey: 'storefront.seo.change-protected' });
    const second = await call('put', '/storefront/admin/seo/protected', session, body);
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({
      details: { actionKey: 'storefront.seo.change-protected' },
    });
    next = err({ code: 'storefront.seo-version-not-found' });
    expect(
      (
        await call('post', '/storefront/admin/seo/restore', session, {
          expectedVersion: 3,
          version: 99,
        })
      ).status,
    ).toBe(404);
  });

  it('answers the public read with no session and no cache', async () => {
    await boot();
    next = ok({ siteName: 'Shop', indexing: false });
    const res = await http().get('/storefront/seo').set({ 'x-market-id': code });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ seo: { siteName: 'Shop', indexing: false } });
    expect(calls).toEqual([{ name: 'public', input: {} }]);
  });
});
