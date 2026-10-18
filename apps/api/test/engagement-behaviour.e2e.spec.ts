import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { BEHAVIOUR_EVENT_REPOSITORY } from '../src/modules/engagement/application/ports/behaviour-event.repository';
import { PERSONALIZATION_SETTING_REPOSITORY } from '../src/modules/engagement/application/ports/personalization-setting.repository';
import {
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
} from '../src/modules/engagement/application/testing/in-memory-engagement';
import { ENGAGEMENT_STATUS } from '../src/modules/engagement/presentation/http-answers';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Behaviour capture over HTTP (personalization 1a): the storefront's event route for a guest and
// a signed-in customer, and the customer's personalization switch, with the real guards,
// controllers and use cases; the stores are in memory and the guest tokens are real. Proves the
// guest cookie (its attributes, set once, reused), Global Privacy Control, that the customer comes
// from the session, CSRF on the customer's writes, closed bodies and `no-store`.

const START = Temporal.Instant.from('2026-10-18T09:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa201);
const PRODUCT = id<'Product'>(0x101);
const fakes = new IdentityFakes();
const sessionTokens = new RandomSessionTokens();
const VIEWED = { kind: 'product-viewed', productId: PRODUCT };

describe('engagement routes over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let events: InMemoryBehaviourEvents;
  let settings: InMemoryPersonalizationSettings;
  let clock: FixedClock;
  const http = () => request(app!.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(BEHAVIOUR_EVENT_REPOSITORY)
          .useValue(events)
          .overrideProvider(PERSONALIZATION_SETTING_REPOSITORY)
          .useValue(settings),
    }));
  }

  function customerSession(code: string) {
    const marketId = code as AccountState['marketId'];
    fakes.seedAccount({
      id: ACCOUNT,
      marketId,
      population: 'customer',
      email: { typed: 'Shopper@Example.com', normalized: 'shopper@example.com' },
      displayName: null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    const issued = sessionTokens.issue();
    void fakes.sessionRepository.add(
      { marketId, tenantId: 'default' } as never,
      openSession({
        id: id<'Session'>(0xf201),
        marketId,
        accountId: ACCOUNT,
        population: 'customer',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      cookie: `__Host-session-customer-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    events = new InMemoryBehaviourEvents();
    settings = new InMemoryPersonalizationSettings();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal code of the use cases to its exact status', () => {
    expect(ENGAGEMENT_STATUS).toEqual({ 'validation.failed': 400 });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('gives a guest a 30-day cookie on the first event and reuses it', async () => {
      await boot();
      const first = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code })
        .send(VIEWED);
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.body).toEqual({ recorded: true });
      const setCookie = ([] as string[]).concat(first.headers['set-cookie'] ?? []);
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toMatch(
        new RegExp(
          `^__Host-engagement-guest-${code}=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax$`,
        ),
      );
      const cookie = setCookie[0]!.split(';')[0]!;

      const second = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code, cookie })
        .send({ kind: 'search-performed', query: 'lamb' });
      expect(second.status).toBe(200);
      expect(second.headers['set-cookie']).toBeUndefined();
      expect(events.rows).toHaveLength(2);
      const [a, b] = events.rows.map((row) => row.subject);
      expect(a).toEqual(b);
      expect(a?.kind).toBe('guest');
      expect(a?.kind === 'guest' && /^[0-9a-f]{64}$/.test(a.guestHash)).toBe(true);
      expect(JSON.stringify(events.rows)).not.toContain(cookie.split('=')[1]);
    });

    it('records nothing under Sec-GPC: 1 and expires a guest cookie sent', async () => {
      await boot();
      const res = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code, 'sec-gpc': '1' })
        .send(VIEWED);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recorded: false });
      expect(res.headers['set-cookie']).toBeUndefined();

      const withCookie = await http()
        .post('/engagement/events')
        .set({
          'x-market-id': code,
          'sec-gpc': '1',
          cookie: `__Host-engagement-guest-${code}=${'g'.repeat(43)}`,
        })
        .send(VIEWED);
      expect(withCookie.body).toEqual({ recorded: false });
      expect(withCookie.headers['set-cookie']).toEqual([
        `__Host-engagement-guest-${code}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ]);
      expect(events.rows).toEqual([]);
    });

    it('refuses an unknown field, a bad body and a non-JSON body', async () => {
      await boot();
      const unknown = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code })
        .send({ ...VIEWED, accountId: ACCOUNT });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
      });
      const bad = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code })
        .send({ kind: 'search-performed' });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({
        details: { fields: [{ path: 'query', code: 'required' }] },
      });
      const text = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code, 'content-type': 'text/plain' })
        .send('product-viewed');
      expect(text.status).toBe(415);
      expect(events.rows).toEqual([]);
    });

    it("records a signed-in customer's event under the account, with CSRF", async () => {
      await boot();
      const headers = customerSession(code);
      const noCsrf = { 'x-market-id': headers['x-market-id'], cookie: headers.cookie };
      const missing = await http().post('/engagement/events').set(noCsrf).send(VIEWED);
      expect(missing.status).toBe(403);

      const res = await http().post('/engagement/events').set(headers).send(VIEWED);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ recorded: true });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(events.rows.map((row) => [row.marketId, row.subject])).toEqual([
        [code, { kind: 'account', accountId: ACCOUNT }],
      ]);
    });

    it('switches personalization off, which deletes and stops recording', async () => {
      await boot();
      const visitor = await http()
        .get('/customers/me/personalization')
        .set({ 'x-market-id': code });
      expect(visitor.status).toBe(401);

      const headers = customerSession(code);
      await http().post('/engagement/events').set(headers).send(VIEWED);
      const before = await http().get('/customers/me/personalization').set(headers);
      expect(before.status).toBe(200);
      expect(before.headers['cache-control']).toBe('no-store');
      expect(before.body).toEqual({ enabled: true, changedAt: null });

      const off = await http()
        .put('/customers/me/personalization')
        .set(headers)
        .send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ enabled: false, changedAt: START.toString() });
      expect(events.rows).toEqual([]);

      const after = await http().post('/engagement/events').set(headers).send(VIEWED);
      expect(after.body).toEqual({ recorded: false });
      expect(events.rows).toEqual([]);

      const wrong = await http()
        .put('/customers/me/personalization')
        .set(headers)
        .send({ enabled: 'yes' });
      expect(wrong.status).toBe(400);
      const noCsrf = { 'x-market-id': headers['x-market-id'], cookie: headers.cookie };
      const forged = await http()
        .put('/customers/me/personalization')
        .set(noCsrf)
        .send({ enabled: true });
      expect(forged.status).toBe(403);
    });
  });
});
