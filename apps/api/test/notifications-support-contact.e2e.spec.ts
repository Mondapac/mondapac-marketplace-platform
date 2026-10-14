import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { SetSupportContact } from '../src/modules/notifications/application/use-cases/set-support-contact.use-case';
import { ViewSupportContact } from '../src/modules/notifications/application/use-cases/view-support-contact.use-case';
import { NOTIFICATIONS_STATUS } from '../src/modules/notifications/presentation/http-answers';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The support contact routes over HTTP: the real guards and controller; the use cases are stubs,
// so this proves the session, the admin population, CSRF, the closed body, the status of each
// refusal, the answer shape and `no-store`. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
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
const PATH = '/notifications/admin/support-contact';

it('maps every refusal code of the support contact routes to its exact status', () => {
  expect(NOTIFICATIONS_STATUS).toEqual({ 'validation.failed': 400, 'notifications.conflict': 409 });
});

describe.each(TEST_MARKETS)('support contact over HTTP in market %s', (code) => {
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
          .overrideProvider(ViewSupportContact)
          .useValue(stub('view'))
          .overrideProvider(SetSupportContact)
          .useValue(stub('set')),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'notif-seed-0001'), {});
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
    next = ok({ email: 'help@example.com', version: 2 });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read and set the address, passing the email to the use case', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    const read = await call('get', 'admin', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({ email: 'help@example.com', version: 2 });

    const set = await call('put', 'admin', session, {
      email: 'care@example.com',
      expectedVersion: 2,
    });
    expect(set.status).toBe(200);
    expect(set.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([
      { name: 'view', input: {} },
      { name: 'set', input: { email: 'care@example.com', expectedVersion: 2 } },
    ]);
  });

  it('refuses a set without CSRF, with a stray field and not as JSON', async () => {
    await boot();
    const session = sessionOf('admin', 2);

    expect(
      (await call('put', 'admin', { cookie: session.cookie }, { email: 'a@b.com' })).status,
    ).toBe(403);
    const extra = await call('put', 'admin', session, { email: 'a@b.com', name: 'x' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'name', code: 'unknown-field' }] },
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
    const put = () => call('put', 'admin', session, { email: 'a@b.com' });

    next = err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    const invalid = await put();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ details: { fields: [{ path: 'email' }] } });
    next = err({ code: 'notifications.conflict' });
    const conflict = await put();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ statusCode: 409, code: 'notifications.conflict' });
    next = err({ code: 'access.denied' });
    expect((await put()).status).toBe(403);
  });
});
