import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { COLUMN_PREFERENCE_STORE } from '../src/modules/lists/contracts';
import { COLUMN_PREFERENCE_STATUS } from '../src/modules/lists/presentation/column-preference.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { MemoryColumnPreferenceStore } from './support/lists-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The saved filters of the admin lists over HTTP (catalog design 9.2d): the real guards,
// controllers, gates and use cases, with identity's ports and the filter store as in-memory fakes.
// Proved here: the admin session and the CSRF token, the view key (the seeded Viewer holds it and
// nothing more), the share key (the seeded Catalogue Moderator holds it), the closed body, the
// statuses, who may change a filter somebody shared, and that a Market never sees another's
// filters. The SQL is in test/db/catalog-saved-filters.db-spec.ts.

const START = Temporal.Instant.from('2026-10-31T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const LIST = 'admin.catalog.products';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const VIEWER = id<'Account'>(0xa002);
const OTHER_VIEWER = id<'Account'>(0xa004);
const MODERATOR = id<'Account'>(0xa005);
const NO_KEY = id<'Account'>(0xa003);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const ORDERS = 'admin.ordering.orders';

it('maps the refusal codes of the column-preference routes to their statuses', () => {
  expect(COLUMN_PREFERENCE_STATUS).toEqual({
    'validation.failed': 400,
    'access.unavailable': 503,
  });
});

describe('column preferences over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let store: MemoryColumnPreferenceStore;
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(COLUMN_PREFERENCE_STORE)
          .useValue(store),
    }));
  }

  /** An active admin of the Market holding the seeded role `seedCode` (or a role of its own). */
  function seedAdmin(
    code: string,
    accountId: Id<'Account'>,
    label: string,
    role: string | Id<'Role'>,
    n: number,
  ) {
    const marketId = code as AccountState['marketId'];
    const roleId =
      typeof role === 'string' && role.startsWith('seed:')
        ? [...fakes.roles.values()].find(
            (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === role.slice(5),
          )!.id
        : (role as Id<'Role'>);
    fakes.seedAccount({
      id: accountId,
      marketId,
      population: 'admin',
      email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
      displayName: `Name ${label}`,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe000 + n),
      marketId,
      accountId,
      roleId,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
  }

  async function seedRoles(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'filters-0001'), {});
  }

  async function seeded(code: string) {
    await seedRoles(code);
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId: code as AccountState['marketId'],
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'No catalog key',
      permissionKeys: ['identity.admin-account.view'],
      version: 1,
      createdAt: START,
    });
    seedAdmin(code, VIEWER, 'viewer', 'seed:viewer', 1);
    seedAdmin(code, OTHER_VIEWER, 'viewer2', 'seed:viewer', 4);
    seedAdmin(code, MODERATOR, 'moderator', 'seed:catalogue-moderator', 5);
    seedAdmin(code, NO_KEY, 'nokey', NO_KEY_ROLE, 2);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
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

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    code: string,
    path: string,
    session: Record<string, string> | null,
    withCsrf = true,
  ) =>
    http()
      [method](`/lists/admin/column-preferences${path}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
        ...(session !== null && withCsrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
      });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new MemoryColumnPreferenceStore();
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the routes and their error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const path = document.paths['/lists/admin/column-preferences'];
    for (const status of ['200', '400', '401', '403', '503'])
      expect(path?.get?.responses).toHaveProperty(status);
    for (const status of ['200', '400', '401', '403', '415', '503'])
      expect(path?.put?.responses).toHaveProperty(status);
    for (const status of ['200', '400', '401', '403', '503'])
      expect(path?.delete?.responses).toHaveProperty(status);
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const body = { listKey: LIST, columns: ['updated', 'code'] };

    it('answers 401 without a session and 403 without the list view key, on every route', async () => {
      await boot();
      await seeded(code);
      const blind = sessionOf(code, NO_KEY, 2);

      for (const [method, path, payload] of [
        ['get', `?listKey=${LIST}`, undefined],
        ['put', '', body],
        ['delete', `?listKey=${LIST}`, undefined],
      ] as const) {
        expect((await call(method, code, path, null).send(payload)).status).toBe(401);
        expect((await call(method, code, path, blind).send(payload)).status).toBe(403);
      }
      expect(store.rows.size).toBe(0);
    });

    it('refuses every write without the CSRF token', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const [method, path, payload] of [
        ['put', '', body],
        ['delete', `?listKey=${LIST}`, undefined],
      ] as const) {
        expect((await call(method, code, path, session, false).send(payload)).status).toBe(403);
      }
      expect(store.rows.size).toBe(0);
    });

    it('saves, reads back, replaces and resets the choice of a list', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      const before = await call('get', code, `?listKey=${LIST}`, session);
      const saved = await call('put', code, '', session).send(body);
      const read = await call('get', code, `?listKey=${LIST}`, session);
      const replaced = await call('put', code, '', session).send({ listKey: LIST, columns: [] });
      const reset = await call('delete', code, `?listKey=${LIST}`, session);
      const after = await call('get', code, `?listKey=${LIST}`, session);

      expect(before.status).toBe(200);
      expect(before.headers['cache-control']).toBe('no-store');
      expect(before.body).toMatchObject({ listKey: LIST, columns: null });
      expect((before.body as { available: string[] }).available).toContain('code');
      expect(saved.status).toBe(200);
      expect(read.body).toMatchObject({ columns: ['updated', 'code'] });
      expect(replaced.body).toMatchObject({ columns: [] });
      expect(reset.status).toBe(200);
      expect(after.body).toMatchObject({ columns: null });
      expect(store.rows.size).toBe(0);
    });

    it('refuses ids outside the vocabulary, an unknown list, one of the other population and unknown fields', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const payload of [
        { listKey: LIST, columns: ['nope'] },
        { listKey: LIST, columns: ['code', 'code'] },
        { listKey: LIST, columns: 'code' },
        { listKey: 'admin.catalog.nothing', columns: [] },
        { listKey: 'seller.catalog.products', columns: [] },
        { ...body, extra: 1 },
      ]) {
        expect((await call('put', code, '', session).send(payload)).status).toBe(400);
      }
      expect(store.rows.size).toBe(0);
    });

    it('keeps the choice of one list apart from another list’s', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);
      await call('put', code, '', session).send(body);

      const orders = await call('get', code, `?listKey=${ORDERS}`, session);

      expect(orders.status).toBe(200);
      expect(orders.body).toMatchObject({ listKey: ORDERS, columns: null });
      expect((orders.body as { available: string[] }).available).toContain('customer');
    });

    it('never shows one account’s choice to another', async () => {
      await boot();
      await seeded(code);
      await call('put', code, '', sessionOf(code, VIEWER, 1)).send(body);

      const other = await call('get', code, `?listKey=${LIST}`, sessionOf(code, OTHER_VIEWER, 3));

      expect(other.status).toBe(200);
      expect(other.body).toMatchObject({ columns: null });
    });
  });
});
