import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { StaleAggregateError } from '../src/platform/unit-of-work/errors';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { withRoleLimit } from './support/role-limits';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The role editor over HTTP, both scopes (identity design 5.3, 8.6; slice 10): create, edit and
// delete with the real guards, controllers, gate and use cases, identity's database ports as
// in-memory fakes and a fixed clock. Sessions are seeded into the fake store.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const CANARY = 'Canary Role Name 7c41';

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const CUSTOMER = accountId(3);
const OWNER = accountId(4);
const MANAGER = accountId(5);
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const OTHER_SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b002');
const OTHER_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c901');

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('role editor over HTTP (integration, slice 10)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot(options: { limit?: number; env?: Record<string, string> } = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...options.env },
      panelOrigins: true,
      override: (builder) => {
        const built = fakes.override(builder).overrideProvider(CLOCK).useValue(clock);
        return options.limit === undefined ? built : withRoleLimit(built, options.limit);
      },
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, scope: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'editor-0001'), {});
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
    const assign = (n: number, idOf: Id<'Account'>, roleId: Id<'Role'>) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    account(1, ROOT, 'admin');
    assign(1, ROOT, roleOf(code, 'platform', 'platform-administrator'));
    account(2, VIEWER, 'admin');
    assign(2, VIEWER, roleOf(code, 'platform', 'viewer'));
    account(3, CUSTOMER, 'customer');
    fakes.seedSellerAccess({
      sellerId: SELLER_ID,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 1,
      createdAt: START,
    });
    for (const [n, idOf, seedCode] of [
      [4, OWNER, 'seller-owner'],
      [5, MANAGER, 'store-manager'],
    ] as const) {
      account(n, idOf, 'seller');
      fakes.seedMembership({
        id: id<'SellerMembership'>(`01990000-0000-7000-8000-${n12(0xe000 + n)}`),
        marketId,
        accountId: idOf,
        sellerId: SELLER_ID,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
      assign(n, idOf, roleOf(code, 'seller', seedCode));
    }
    // Another seller's custom role: never visible to or editable by SELLER_ID.
    fakes.seedRole({
      id: OTHER_ROLE,
      marketId,
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: OTHER_SELLER_ID,
      name: 'Other shop role',
      permissionKeys: ['identity.team-member.view'],
      version: 1,
      createdAt: START,
    });
  }

  let sessions = 0;
  function sessionOf(
    code: string,
    account: Id<'Account'>,
    population: 'admin' | 'seller' | 'customer',
  ) {
    const issued = tokens.issue();
    sessions += 1;
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + sessions)}`),
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
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    code: string,
    scope: 'admin' | 'seller',
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const pending = http()
      [method](`/identity/${scope}/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, scope), ...headers });
    return body === undefined ? pending : pending.send(body as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    sessions = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the six routes in OpenAPI', async () => {
    await boot({ limit: 5, env: { API_DOCS_ENABLED: 'true' } });

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(document.paths['/identity/admin/roles'] ?? {}).sort()).toEqual([
      'get',
      'post',
    ]);
    expect(Object.keys(document.paths['/identity/admin/roles/{roleId}'] ?? {}).sort()).toEqual([
      'delete',
      'put',
    ]);
    expect(Object.keys(document.paths['/identity/seller/roles'] ?? {}).sort()).toEqual([
      'get',
      'post',
    ]);
    expect(Object.keys(document.paths['/identity/seller/roles/{roleId}'] ?? {}).sort()).toEqual([
      'delete',
      'put',
    ]);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('platform: creates, lists with the name, edits and deletes a custom role; logs no name', async () => {
      await boot({ limit: 5 });
      await seeded(code);
      const root = sessionOf(code, ROOT, 'admin');

      const created = await call('post', code, 'admin', 'roles', root, {
        name: CANARY,
        permissionKeys: ['identity.platform-role.view', 'identity.admin-account.invite'],
      });
      expect(created.status).toBe(201);
      const roleId = (created.body as { roleId: string }).roleId;
      expect(created.body).toEqual({ code: 'role.created', roleId });

      const listed = await call('get', code, 'admin', 'roles', root);
      const mine = (listed.body as { items: { roleId: string; name: string | null }[] }).items.find(
        (item) => item.roleId === roleId,
      )!;
      expect(mine).toMatchObject({
        name: CANARY,
        kind: 'custom',
        permissionCount: 2,
        actions: { edit: { allowed: true, code: null }, delete: { allowed: true, code: null } },
      });

      const edited = await call('put', code, 'admin', `roles/${roleId}`, root, {
        name: 'Renamed',
        permissionKeys: ['identity.platform-role.view'],
      });
      expect([edited.status, edited.body]).toEqual([200, { code: 'role.updated', roleId }]);

      const removed = await call('delete', code, 'admin', `roles/${roleId}`, root);
      expect([removed.status, removed.body]).toEqual([200, { code: 'role.deleted', roleId }]);

      const correlationId = created.headers['x-correlation-id'] as string;
      expect(logLines.find((l) => l.msg === 'identity.admin-create-role')).toMatchObject({
        outcome: 'role.created',
        marketId: code,
        correlationId,
      });
      expect(JSON.stringify(logLines)).not.toContain('Canary');
      expect(JSON.stringify(fakes.events)).not.toContain('Canary');
      expect(JSON.stringify(fakes.audits)).not.toContain('Canary');
    });

    it('platform: maps the refusals to their statuses', async () => {
      await boot({ limit: 5 });
      await seeded(code);
      const root = sessionOf(code, ROOT, 'admin');
      const body = { name: 'Taken', permissionKeys: [] };
      const first = await call('post', code, 'admin', 'roles', root, body);
      const roleId = (first.body as { roleId: string }).roleId;
      const system = roleOf(code, 'platform', 'platform-administrator');

      const cases: [string, () => request.Test, number, string][] = [
        [
          'name taken',
          () => call('post', code, 'admin', 'roles', root, body),
          409,
          'role.name-taken',
        ],
        [
          'unknown key',
          () =>
            call('post', code, 'admin', 'roles', root, { name: 'N', permissionKeys: ['x.y.z'] }),
          400,
          'validation.failed',
        ],
        [
          'unknown field',
          () => call('post', code, 'admin', 'roles', root, { ...body, sellerId: SELLER_ID }),
          400,
          'validation.failed',
        ],
        [
          'keys not an array',
          () => call('post', code, 'admin', 'roles', root, { name: 'N', permissionKeys: 'a' }),
          400,
          'validation.failed',
        ],
        [
          'seeded role',
          () => call('put', code, 'admin', `roles/${system}`, root, body),
          409,
          'role.read-only',
        ],
        [
          'malformed id',
          () => call('delete', code, 'admin', 'roles/not-an-id', root),
          404,
          'role.unknown',
        ],
        [
          'a seller role',
          () => call('delete', code, 'admin', `roles/${OTHER_ROLE}`, root),
          404,
          'role.unknown',
        ],
        [
          'viewer lacks the key',
          () => call('delete', code, 'admin', `roles/${roleId}`, sessionOf(code, VIEWER, 'admin')),
          403,
          'access.denied',
        ],
      ];
      for (const [name, pending, status, errorCode] of cases) {
        const response = await pending();
        expect([name, response.status, (response.body as { code: string }).code]).toEqual([
          name,
          status,
          errorCode,
        ]);
      }
      const json = await http()
        .post('/identity/admin/roles')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...root })
        .type('text/plain')
        .send('{}');
      expect(json.status).toBe(415);
    });

    it('platform: needs the CSRF token, the right session population and, for each, no session', async () => {
      await boot({ limit: 5 });
      await seeded(code);
      const root = sessionOf(code, ROOT, 'admin');
      const body = { name: 'N', permissionKeys: [] };

      const noCsrf = await call('post', code, 'admin', 'roles', { cookie: root.cookie }, body);
      expect([noCsrf.status, noCsrf.body]).toEqual([
        403,
        { statusCode: 403, code: 'request.csrf' },
      ]);
      expect((await call('post', code, 'admin', 'roles', {}, body)).status).toBe(401);
      expect(
        (await call('post', code, 'admin', 'roles', sessionOf(code, CUSTOMER, 'customer'), body))
          .status,
      ).toBe(401);
      expect(
        (await call('post', code, 'admin', 'roles', sessionOf(code, OWNER, 'seller'), body)).status,
      ).toBe(401);
      expect([...fakes.roles.values()].some((r) => r.kind === 'custom' && r.name === 'N')).toBe(
        false,
      );
    });

    it('seller: the owner creates, edits and deletes a role for its own shop; staff cannot', async () => {
      await boot({ limit: 5 });
      await seeded(code);
      const owner = sessionOf(code, OWNER, 'seller');

      const created = await call('post', code, 'seller', 'roles', owner, {
        name: 'Packers',
        permissionKeys: ['identity.team-member.view'],
      });
      expect(created.status).toBe(201);
      const roleId = (created.body as { roleId: string }).roleId;
      expect(fakes.roles.get(roleId as Id<'Role'>)).toMatchObject({
        scope: 'seller',
        sellerId: SELLER_ID,
        marketId: code,
      });

      const listed = await call('get', code, 'seller', 'roles', owner);
      const ids = (listed.body as { items: { roleId: string }[] }).items.map((i) => i.roleId);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(ids).toContain(roleId);
      expect(ids).not.toContain(OTHER_ROLE);

      const protectedKey = await call('post', code, 'seller', 'roles', owner, {
        name: 'Greedy',
        permissionKeys: ['identity.team-member.invite'],
      });
      expect([protectedKey.status, (protectedKey.body as { code: string }).code]).toEqual([
        403,
        'role.not-grantable',
      ]);
      const foreign = await call('put', code, 'seller', `roles/${OTHER_ROLE}`, owner, {
        name: 'X',
        permissionKeys: [],
      });
      expect([foreign.status, (foreign.body as { code: string }).code]).toEqual([
        404,
        'role.unknown',
      ]);
      expect((await call('delete', code, 'seller', `roles/${roleId}`, owner)).body).toEqual({
        code: 'role.deleted',
        roleId,
      });

      const manager = sessionOf(code, MANAGER, 'seller');
      const staff = await call('post', code, 'seller', 'roles', manager, {
        name: 'Nope',
        permissionKeys: [],
      });
      expect([staff.status, staff.body]).toEqual([403, { statusCode: 403, code: 'access.denied' }]);
      // The catalogue is open to staff with the view key, with every action denied.
      const view = await call('get', code, 'seller', 'roles', manager);
      expect(view.status).toBe(200);
      // An admin session on the seller routes is refused, and a query parameter too.
      expect(
        (await call('get', code, 'seller', 'roles', sessionOf(code, ROOT, 'admin'))).status,
      ).toBe(401);
      const query = await http()
        .get('/identity/seller/roles?sellerId=x')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...owner });
      expect(query.status).toBe(400);
    });
  });

  it.each(TEST_MARKETS)(
    'maps role.in-use and a lost race (conflict.stale) to 409 in %s',
    async (code) => {
      await boot({ limit: 5 });
      await seeded(code);
      const root = sessionOf(code, ROOT, 'admin');
      const created = await call('post', code, 'admin', 'roles', root, {
        name: 'Held',
        permissionKeys: [],
      });
      const roleId = (created.body as { roleId: string }).roleId;
      fakes.seedAssignment({
        id: id<'RoleAssignment'>('01990000-0000-7000-8000-00000000e999'),
        marketId: code as AccountState['marketId'],
        accountId: VIEWER,
        roleId: roleId as Id<'Role'>,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });

      const inUse = await call('delete', code, 'admin', `roles/${roleId}`, root);
      expect([inUse.status, inUse.body]).toEqual([409, { statusCode: 409, code: 'role.in-use' }]);

      // A write that loses the version race: the platform filter answers 409 conflict.stale.
      const lost = jest
        .spyOn(fakes.roleRepository, 'saveCustom')
        .mockRejectedValue(new StaleAggregateError('role', roleId));
      try {
        const stale = await call('put', code, 'admin', `roles/${roleId}`, root, {
          name: 'Held 2',
          permissionKeys: [],
        });
        expect(stale.status).toBe(409);
        expect((stale.body as { code: string }).code).toBe('conflict.stale');
      } finally {
        lost.mockRestore();
      }
    },
  );

  it('fails closed while the Market configures no role limit (access.unavailable)', async () => {
    await boot();
    await seeded('AU');

    const refused = await call('post', 'AU', 'admin', 'roles', sessionOf('AU', ROOT, 'admin'), {
      name: 'N',
      permissionKeys: [],
    });

    expect([refused.status, (refused.body as { code: string }).code]).toEqual([
      503,
      'access.unavailable',
    ]);
  });
});
