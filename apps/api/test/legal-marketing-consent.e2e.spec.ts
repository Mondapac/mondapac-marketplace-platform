import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { MARKETING_CONSENT_REPOSITORY } from '../src/modules/legal/application/ports/marketing-consent.repository';
import { InMemoryMarketingConsents } from '../src/modules/legal/application/testing/in-memory-marketing-consents';
import { LEGAL_STATUS } from '../src/modules/legal/presentation/http-answers';
import {
  UNSUBSCRIBE_TOKENS,
  type UnsubscribeTokens,
} from '../src/modules/notifications/application/ports/unsubscribe-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Marketing consent over HTTP (personalization 1b): the email preferences routes of the signed-in
// customer and the public one-click unsubscribe route, with the real guards, controllers, use
// cases and legal facade; the consent store is in memory. Proves the customer comes from the
// session, CSRF on the write, closed bodies, `no-store`, that the unsubscribe GET changes nothing,
// that a mail client's form-encoded one-click POST with no Market header works, and that a forged
// or foreign token is refused.

const START = Temporal.Instant.from('2026-10-18T09:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa101);
const fakes = new IdentityFakes();
const sessionTokens = new RandomSessionTokens();

describe('marketing consent routes over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let store: InMemoryMarketingConsents;
  let clock: FixedClock;
  const http = () => request(app!.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(MARKETING_CONSENT_REPOSITORY)
          .useValue(store),
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
        id: id<'Session'>(0xf101),
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
    store = new InMemoryMarketingConsents();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal code of the use cases to its exact status', () => {
    expect(LEGAL_STATUS).toEqual({ 'validation.failed': 400 });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('refuses a visitor without a session', async () => {
      await boot();
      const res = await http().get('/customers/me/email-preferences').set({ 'x-market-id': code });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'access.unauthenticated' });
    });

    it('reads no consent first, records the opt-in, all no-store', async () => {
      await boot();
      const headers = customerSession(code);
      const before = await http().get('/customers/me/email-preferences').set(headers);
      expect(before.status).toBe(200);
      expect(before.headers['cache-control']).toBe('no-store');
      expect(before.body).toEqual({ marketing: false, changedAt: null });

      const saved = await http()
        .put('/customers/me/email-preferences')
        .set(headers)
        .send({ marketing: true, source: 'sign-up' });
      expect(saved.status).toBe(200);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(saved.body).toEqual({ marketing: true, changedAt: START.toString() });
      expect(store.changes).toMatchObject([{ granted: true, source: 'sign-up', marketId: code }]);
    });

    it('refuses a write without the CSRF token, with an unknown field or a wrong type', async () => {
      await boot();
      const headers = customerSession(code);
      const noCsrf = { 'x-market-id': headers['x-market-id'], cookie: headers.cookie };
      const missing = await http()
        .put('/customers/me/email-preferences')
        .set(noCsrf)
        .send({ marketing: true });
      expect(missing.status).toBe(403);

      const unknown = await http()
        .put('/customers/me/email-preferences')
        .set(headers)
        .send({ marketing: true, accountId: ACCOUNT });
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
      });

      const wrong = await http()
        .put('/customers/me/email-preferences')
        .set(headers)
        .send({ marketing: 'yes' });
      expect(wrong.status).toBe(400);
      expect(store.changes).toEqual([]);
    });

    it('unsubscribes with one click from a mail client: no session, no Market header', async () => {
      await boot();
      const headers = customerSession(code);
      await http()
        .put('/customers/me/email-preferences')
        .set(headers)
        .send({ marketing: true, source: 'account' });
      const tokens = app!.get<UnsubscribeTokens>(UNSUBSCRIBE_TOKENS);
      const token = tokens.issue(testMarketContext(code, 'default'), ACCOUNT);
      const path = `/notifications/unsubscribe/${code}?token=${token}`;

      const checked = await http().get(path);
      expect(checked.status).toBe(200);
      expect(checked.headers['cache-control']).toBe('no-store');
      expect(checked.body).toEqual({ valid: true });
      expect(store.changes).toHaveLength(1);

      const clicked = await http().post(path).type('form').send('List-Unsubscribe=One-Click');
      expect(clicked.status).toBe(200);
      expect(clicked.body).toEqual({ unsubscribed: true });
      const again = await http().post(path);
      expect(again.status).toBe(200);
      expect(store.changes.map(({ granted, source }) => [granted, source])).toEqual([
        [true, 'account'],
        [false, 'unsubscribe-link'],
      ]);

      const after = await http().get('/customers/me/email-preferences').set(headers);
      expect(after.body).toMatchObject({ marketing: false });
    });

    it('refuses a forged token, a token of another Market and a missing one', async () => {
      await boot();
      const headers = customerSession(code);
      await http().put('/customers/me/email-preferences').set(headers).send({ marketing: true });
      const tokens = app!.get<UnsubscribeTokens>(UNSUBSCRIBE_TOKENS);
      const other = TEST_MARKETS.find((market) => market !== code)!;
      for (const query of [
        `?token=${tokens.issue(testMarketContext(other, 'default'), ACCOUNT)}`,
        `?token=u1.${ACCOUNT}.${'A'.repeat(43)}`,
        '',
      ]) {
        const res = await http().post(`/notifications/unsubscribe/${code}${query}`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          statusCode: 400,
          code: 'notifications.unsubscribe-link-invalid',
        });
      }
      expect(store.changes).toHaveLength(1);
    });
  });
});
