import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ADDRESS_CIPHER } from '../src/modules/customers/application/ports/address-cipher';
import { ADDRESS_REPOSITORY } from '../src/modules/customers/application/ports/address.repository';
import {
  InMemoryAddresses,
  ReversibleAddressCipher,
} from '../src/modules/customers/application/testing/in-memory-address-book';
import { CUSTOMERS_STATUS } from '../src/modules/customers/presentation/http-answers';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The address book routes over HTTP: the real guards, controller and use cases; the store and the
// cipher are in memory. Proves the customer comes from the session (anonymous and panel sessions
// are refused), the CSRF token on writes, `no-store`, closed bodies and the status of each
// refusal. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-17T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa101);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('customer address book routes over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let store: InMemoryAddresses;
  let clock: FixedClock;
  const http = () => request(app!.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ADDRESS_REPOSITORY)
          .useValue(store)
          .overrideProvider(ADDRESS_CIPHER)
          .useValue(new ReversibleAddressCipher()),
    }));
  }

  function customerSession(code: string, account: Id<'Account'> = ACCOUNT, n = 0) {
    const marketId = code as AccountState['marketId'];
    fakes.seedAccount({
      id: account,
      marketId,
      population: 'customer',
      email: { typed: `Shopper${n}@Example.com`, normalized: `shopper${n}@example.com` },
      displayName: null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      { marketId, tenantId: 'default' } as never,
      openSession({
        id: id<'Session'>(0xf101 + n),
        marketId,
        accountId: account,
        population: 'customer',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-customer-${code}=${issued.token}`,
      csrf: csrfTokenFor(issued.token),
    };
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new InMemoryAddresses();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal code of the use cases to its exact status', () => {
    expect(CUSTOMERS_STATUS).toEqual({
      'validation.failed': 400,
      'customers.address-not-found': 404,
      'customers.address-limit-reached': 422,
      'customers.conflict': 409,
      'customers.account-deletion-disabled': 403,
      'customers.account-deletion-blocked': 409,
      'customers.account-deletion-already-requested': 409,
      'customers.account-deletion-request-not-found': 404,
      'customers.account-deletion-in-progress': 409,
      'customers.buyer-account-not-found': 404,
      'second-factor.required': 403,
      'second-factor.enrolment-required': 403,
      'customers.unavailable': 503,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const body = (line1: string, extra: Record<string, unknown> = {}) => ({
      recipientFirstName: 'Aisha',
      recipientLastName: 'Rahman',
      phone: '0412 345 678',
      line1,
      line2: null,
      suburb: 'Sunnybank',
      region: code === 'AU' ? 'QLD' : 'ZA',
      postcode: code === 'AU' ? '4109' : '1000001',
      deliveryNotes: 'Leave at the door',
      ...extra,
    });

    it('refuses a visitor without a session', async () => {
      await boot();
      const res = await http().get('/customers/me/addresses').set({ 'x-market-id': code });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'access.unauthenticated' });
    });

    it('adds, lists, changes, picks the default and removes, all no-store', async () => {
      await boot();
      const { cookie, csrf } = customerSession(code);
      const headers = { 'x-market-id': code, cookie, 'x-csrf-token': csrf };

      const created = await http()
        .post('/customers/me/addresses')
        .set(headers)
        .send(body('One St'));
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body).toMatchObject({
        line1: 'One St',
        phone: '0412345678',
        isDefault: true,
        countryCode: code === 'AU' ? 'AU' : 'JP',
        deliveryNotes: 'Leave at the door',
      });
      const first = (created.body as { id: string }).id;
      const second = await http().post('/customers/me/addresses').set(headers).send(body('Two St'));
      const secondId = (second.body as { id: string }).id;

      const listed = await http().get('/customers/me/addresses').set(headers);
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({
        limit: code === 'AU' ? 20 : 5,
        addresses: [
          { id: first, isDefault: true },
          { id: secondId, isDefault: false },
        ],
      });

      const changed = await http()
        .put(`/customers/me/addresses/${secondId}`)
        .set(headers)
        .send(body('Two St, Unit 9'));
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ id: secondId, line1: 'Two St, Unit 9' });

      const picked = await http().post(`/customers/me/addresses/${secondId}/default`).set(headers);
      expect(picked.status).toBe(200);
      expect(picked.body).toMatchObject({ addresses: [{ id: secondId, isDefault: true }, {}] });

      const removed = await http().delete(`/customers/me/addresses/${secondId}`).set(headers);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ deleted: true });
      const after = await http().get('/customers/me/addresses').set(headers);
      expect(after.body).toMatchObject({ addresses: [{ id: first, isDefault: true }] });
    });

    it("never reaches another customer's address", async () => {
      await boot();
      const alice = customerSession(code);
      const bob = customerSession(code, id<'Account'>(0xb202), 1);
      const as = (s: { cookie: string; csrf: string }) => ({
        'x-market-id': code,
        cookie: s.cookie,
        'x-csrf-token': s.csrf,
      });
      const created = await http()
        .post('/customers/me/addresses')
        .set(as(alice))
        .send(body('One St'));
      const target = (created.body as { id: string }).id;
      const before = JSON.stringify([...store.rows.values()]);

      const put = await http()
        .put(`/customers/me/addresses/${target}`)
        .set(as(bob))
        .send(body('Hijack'));
      const def = await http().post(`/customers/me/addresses/${target}/default`).set(as(bob));
      const del = await http().delete(`/customers/me/addresses/${target}`).set(as(bob));
      for (const res of [put, def, del]) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'customers.address-not-found' });
      }
      const listed = await http().get('/customers/me/addresses').set(as(bob));
      expect(listed.body).toMatchObject({ addresses: [] });
      expect(JSON.stringify([...store.rows.values()])).toBe(before);
    });

    it('refuses a write without the CSRF token, and an unknown key in the body', async () => {
      await boot();
      const { cookie, csrf } = customerSession(code);

      const noCsrf = await http()
        .post('/customers/me/addresses')
        .set({ 'x-market-id': code, cookie })
        .send(body('One St'));
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toMatchObject({ code: 'request.csrf' });

      const unknown = await http()
        .post('/customers/me/addresses')
        .set({ 'x-market-id': code, cookie, 'x-csrf-token': csrf })
        .send(body('One St', { accountId: id<'Account'>(0xdead) }));
      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'accountId', code: 'unknown-field' }] },
      });
      expect(store.rows.size).toBe(0);
    });

    it('answers 400 with field codes, 404 for an unknown address and 422 past the limit', async () => {
      await boot();
      const { cookie, csrf } = customerSession(code);
      const headers = { 'x-market-id': code, cookie, 'x-csrf-token': csrf };

      const invalid = await http()
        .post('/customers/me/addresses')
        .set(headers)
        .send(body('One St', { postcode: 'ABC' }));
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'postcode', code: 'format' }] },
      });
      expect(JSON.stringify(invalid.body)).not.toContain('ABC');

      const missing = await http()
        .put(`/customers/me/addresses/${id<'CustomerAddress'>(0x99)}`)
        .set(headers)
        .send(body('Nowhere'));
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: 'customers.address-not-found' });

      const limit = code === 'AU' ? 20 : 5;
      for (let n = 0; n < limit; n += 1) {
        clock.advance(Temporal.Duration.from({ seconds: 1 }));
        const res = await http()
          .post('/customers/me/addresses')
          .set(headers)
          .send(body(`St ${n}`));
        expect(res.status).toBe(201);
      }
      const over = await http().post('/customers/me/addresses').set(headers).send(body('Over'));
      expect(over.status).toBe(422);
      expect(over.body).toEqual({
        statusCode: 422,
        code: 'customers.address-limit-reached',
        details: { limit },
      });
    });
  });
});
