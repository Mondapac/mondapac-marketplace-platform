import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// Customer lookup by exact email over HTTP (identity design 12.1 `identity.customer-account.view`;
// slice 8d): `POST /identity/admin/customers/lookup` with the real guards, controller, gate and
// use case, identity's database ports as in-memory fakes and a fixed clock.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const FINANCE = accountId(2);
const SUPPORT = accountId(3);
const CUSTOMER = accountId(4);
const OTHER_MARKET_CUSTOMER = accountId(5);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('admin customer lookup over HTTP (integration, slice 8d)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'lookup-0001'), {});
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const account = (
      n: number,
      idOf: Id<'Account'>,
      population: AccountState['population'],
      email: { typed: string; normalized: string },
      marketCode: string = code,
    ) =>
      fakes.seedAccount({
        id: idOf,
        marketId: marketCode as AccountState['marketId'],
        population,
        email,
        displayName: population === 'customer' ? null : `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(n, idOf, 'admin', { typed: `admin${n}@x.test`, normalized: `admin${n}@x.test` });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, FINANCE, 'finance');
    admin(3, SUPPORT, 'operations-support');
    account(4, CUSTOMER, 'customer', {
      typed: 'Jane.Doe@Example.com',
      normalized: 'jane.doe@example.com',
    });
    account(
      5,
      OTHER_MARKET_CUSTOMER,
      'customer',
      { typed: 'Abroad@Example.com', normalized: 'abroad@example.com' },
      other,
    );
  }

  /** An admin session stored as a sign-in would; answers its cookie and CSRF token. */
  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
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

  const lookup = (code: string, body: unknown, headers: Record<string, string>) =>
    http()
      .post('/identity/admin/customers/lookup')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, { post?: unknown }>;
      components: { schemas: Record<string, unknown> };
    };

    expect(document.paths['/identity/admin/customers/lookup']?.post).toBeDefined();
    for (const schema of ['AdminCustomerLookupRequest', 'AdminCustomerView']) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('finds a customer by a mixed-case, padded email; minimal fields; no address in logs', async () => {
      await boot();
      await seeded(code);

      const found = await lookup(
        code,
        { email: '  JANE.doe@example.COM ' },
        sessionOf(code, ROOT, 1),
      );

      expect(found.status).toBe(200);
      expect(found.headers['cache-control']).toBe('no-store');
      expect(found.body).toEqual({
        accountId: CUSTOMER,
        email: 'Jane.Doe@Example.com',
        status: 'active',
        createdAt: START.toString(),
        emailVerified: true,
      });
      const logged = JSON.stringify(logLines).toLowerCase();
      expect(logged).not.toContain('jane.doe');
      expect(logLines.find((l) => l.msg === 'identity.admin-find-customer')).toMatchObject({
        outcome: 'ok',
        marketId: code,
        correlationId: found.headers['x-correlation-id'] as string,
      });
    });

    it('answers a support admin, who holds the key through the default role', async () => {
      await boot();
      await seeded(code);

      const found = await lookup(
        code,
        { email: 'jane.doe@example.com' },
        sessionOf(code, SUPPORT, 3),
      );

      expect(found.status).toBe(200);
    });

    it('gives unknown and other-Market emails the identical 404, and never logs them', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const unknown = await lookup(code, { email: 'nobody@example.com' }, root);
      const abroad = await lookup(code, { email: 'abroad@example.com' }, root);

      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'customer.not-found' });
      expect(abroad.status).toBe(404);
      expect(abroad.body).toEqual(unknown.body);
      const logged = JSON.stringify(logLines).toLowerCase();
      for (const searched of ['nobody@', 'abroad@']) expect(logged).not.toContain(searched);
    });

    it('matches exactly: a prefix or partial address is not found', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      for (const email of ['jane.doe@example.co', 'jane@example.com', 'doe@example.com']) {
        const answer = await lookup(code, { email }, root);
        expect(answer.status).toBe(404);
      }
    });

    it('refuses a missing permission with 403, no CSRF with 403, no session with 401', async () => {
      await boot();
      await seeded(code);

      const denied = await lookup(
        code,
        { email: 'jane.doe@example.com' },
        sessionOf(code, FINANCE, 2),
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ statusCode: 403, code: 'access.denied' });
      const noCsrf = await lookup(
        code,
        { email: 'jane.doe@example.com' },
        { cookie: sessionOf(code, ROOT, 1).cookie },
      );
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const anonymous = await lookup(code, { email: 'jane.doe@example.com' }, {});
      expect(anonymous.status).toBe(401);
    });

    it('refuses a malformed body or address with 400', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      expect((await lookup(code, {}, root)).status).toBe(400);
      expect((await lookup(code, { email: 'x@example.com', extra: 'y' }, root)).status).toBe(400);
      const malformed = await lookup(code, { email: 'not-an-email' }, root);
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ code: 'validation.failed' });
      expect(JSON.stringify(malformed.body)).not.toContain('not-an-email');
    });
  });
});
