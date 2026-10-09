import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The role catalogue over HTTP (identity design 5.3 `identity.platform-role.view`, 8.6 row 6;
// slice 10a): `GET /identity/admin/roles` with the real guards, controller, gate and use case,
// identity's database ports as in-memory fakes and a fixed clock. Sessions are seeded into the
// fake store, as in the 8c list's spec.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const SUPPORT = accountId(3);
const CUSTOMER = accountId(4);
const SELLER = accountId(5);
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b001');

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

const ENTRY_FIELDS = [
  'actions',
  'grantable',
  'kind',
  'name',
  'permissionCount',
  'permissionKeys',
  'roleId',
  'seedCode',
  'version',
];

describe('role catalogue over HTTP (integration, slice 10a)', () => {
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
  const rolesOf = (code: string, scope: 'platform' | 'seller') =>
    [...fakes.roles.values()].filter((r) => r.marketId === code && r.scope === scope);
  const roleOf = (code: string, seedCode: string) =>
    rolesOf(code, 'platform').find((r) => r.seedCode === seedCode)!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'roles-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
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
      account(n, idOf, 'admin');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, VIEWER, 'viewer');
    admin(3, SUPPORT, 'operations-support');
    account(4, CUSTOMER, 'customer');
    account(5, SELLER, 'seller');
  }

  /** A session of `account` and `population`, stored as a sign-in would; answers its cookie. */
  function cookieOf(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'customer' | 'seller' = 'admin',
  ): string {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        sellerId: population === 'seller' ? SELLER_ID : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return `__Host-session-${population}-${code}=${issued.token}`;
  }

  const roles = (code: string, cookie: string | null, query = '') => {
    const call = http()
      .get(`/identity/admin/roles${query}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return cookie === null ? call : call.set('cookie', cookie);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its response in OpenAPI, with no query parameter', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, { get?: { parameters?: { in: string }[] } }>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };

    const operation = document.paths['/identity/admin/roles']?.get;
    expect(operation).toBeDefined();
    expect((operation?.parameters ?? []).filter((p) => p.in === 'query')).toEqual([]);
    expect(document.components.schemas).toHaveProperty(['RoleCatalogueView']);
    expect(Object.keys(document.components.schemas.RoleView?.properties ?? {}).sort()).toEqual(
      ENTRY_FIELDS,
    );
    expect(Object.keys(document.components.schemas.RoleKeyView?.properties ?? {}).sort()).toEqual([
      'grantable',
      'key',
      'protected',
    ]);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the platform roles with keys, grantable and action hints; logs no key', async () => {
      await boot();
      await seeded(code);

      const listed = await roles(code, cookieOf(code, VIEWER, 2));

      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      const items = (listed.body as { items: Record<string, unknown>[] }).items;
      const platform = rolesOf(code, 'platform')
        .map((r) => r.id as string)
        .sort();
      expect(items.map((item) => item.roleId)).toEqual(platform);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(ENTRY_FIELDS);
      }
      expect(items.find((item) => item.seedCode === 'viewer')).toMatchObject({
        roleId: roleOf(code, 'viewer'),
        kind: 'default',
        seedCode: 'viewer',
        name: null,
        permissionCount: 5,
        grantable: true,
        // A viewer holds no editor key: every action is access.denied.
        actions: {
          edit: { allowed: false, code: 'access.denied' },
          delete: { allowed: false, code: 'access.denied' },
        },
      });
      const keys = (listed.body as { keys: { key: string; protected: boolean }[] }).keys;
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.key.startsWith('identity.') || k.key.includes('.'))).toBe(true);
      expect(items.find((item) => item.seedCode === 'platform-administrator')).toMatchObject({
        kind: 'system',
        grantable: false,
      });
      // No seller role, and no permission key in the body.
      for (const sellerRole of rolesOf(code, 'seller')) {
        expect(JSON.stringify(listed.body)).not.toContain(sellerRole.id);
      }
      const correlationId = listed.headers['x-correlation-id'] as string;
      expect(logLines.find((l) => l.msg === 'identity.admin-list-roles')).toMatchObject({
        outcome: 'ok',
        marketId: code,
        correlationId,
      });
      expect(logLines.find((l) => l.msg === 'identity.list-platform-roles')).toMatchObject({
        outcome: 'platform-roles.listed',
        roles: platform.length,
        correlationId,
      });
      expect(JSON.stringify(logLines)).not.toMatch(/identity\.(seller-access|platform-role)\.view/);
    });

    it('answers grantable true for every role to the Platform Administrator', async () => {
      await boot();
      await seeded(code);

      const listed = await roles(code, cookieOf(code, ROOT, 1));

      const items = (listed.body as { items: { grantable: boolean }[] }).items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.grantable)).toBe(true);
    });

    it('refuses an admin without identity.platform-role.view (access.denied), with no role data', async () => {
      await boot();
      await seeded(code);

      const refused = await roles(code, cookieOf(code, SUPPORT, 3));

      expect([refused.status, refused.body]).toEqual([
        403,
        { statusCode: 403, code: 'access.denied' },
      ]);
      expect(logLines.find((l) => l.msg === 'identity.admin-list-roles')).toMatchObject({
        outcome: 'access.denied',
      });
    });

    it('refuses no session, a customer session and a seller session (populations)', async () => {
      await boot();
      await seeded(code);

      expect((await roles(code, null)).status).toBe(401);
      expect((await roles(code, cookieOf(code, CUSTOMER, 4, 'customer'))).status).toBe(401);
      expect((await roles(code, cookieOf(code, SELLER, 5, 'seller'))).status).toBe(401);
      // An admin cookie name carrying a seller's or a customer's session is refused too.
      for (const [account, n, population] of [
        [SELLER, 6, 'seller'],
        [CUSTOMER, 7, 'customer'],
      ] as const) {
        const forged = cookieOf(code, account, n, population).replace(
          `session-${population}-${code}`,
          `session-admin-${code}`,
        );
        const refused = await roles(code, forged);
        expect(refused.status).toBe(401);
        expect(JSON.stringify(refused.body)).not.toContain('roleId');
      }
    });

    it('takes no query parameter: scope, sellerId or any other is validation.failed', async () => {
      await boot();
      await seeded(code);
      const cookie = cookieOf(code, ROOT, 1);

      for (const [query, paths] of [
        ['?scope=seller', ['scope']],
        ['?scope=platform', ['scope']],
        ['?sellerId=01990000-0000-7000-8000-00000000b001', ['sellerId']],
        ['?scope=seller&scope=platform', ['scope']],
        ['?limit=10&after=x', ['after', 'limit']],
      ] as const) {
        const refused = await roles(code, cookie, query);
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: paths.map((path) => ({ path, code: 'unknown' })) },
        });
      }
    });
  });
});
