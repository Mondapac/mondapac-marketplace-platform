import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ADMIN_PRODUCTS_READER } from '../src/modules/catalog/application/ports/admin-products.reader';
import { SAVED_FILTER_REPOSITORY } from '../src/modules/catalog/application/ports/saved-filter.repository';
import { SAVED_FILTER_STATUS } from '../src/modules/catalog/presentation/saved-filter.controller';
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
import { MemorySavedFilters } from './support/saved-filter-fakes';
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
/** The id a create answered (the HTTP body is untyped). */
const idOf = (response: { readonly body: unknown }): string => (response.body as { id: string }).id;

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

const PAYLOAD = {
  v: 1,
  view: 'active',
  q: 'lamb',
  filters: { scope: 'SELLER' },
  sort: 'updated',
  direction: 'desc',
};
const NEW = { listKey: LIST, name: 'Lamb, active', visibility: 'me', payload: PAYLOAD };

it('maps the refusal codes of the saved-filter routes to their statuses', () => {
  expect(SAVED_FILTER_STATUS).toEqual({
    'validation.failed': 400,
    'saved-filter.not-found': 404,
    'saved-filter.name-taken': 409,
    'saved-filter.limit-reached': 409,
    'saved-filter.shared-limit-reached': 409,
    'access.unavailable': 503,
  });
});

describe('saved filters over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let store: MemorySavedFilters;
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
          .overrideProvider(SAVED_FILTER_REPOSITORY)
          .useValue(store)
          .overrideProvider(ADMIN_PRODUCTS_READER)
          .useValue({
            counts: (_m: MarketContext, f: readonly unknown[]) => Promise.resolve(f.map(() => 7)),
          }),
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
      [method](`/catalog/admin/saved-filters${path}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
        ...(session !== null && withCsrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
      });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new MemorySavedFilters();
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the four routes and their error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const base = document.paths['/catalog/admin/saved-filters'];
    const one = document.paths['/catalog/admin/saved-filters/{id}'];
    for (const status of ['200', '400', '401', '403', '503'])
      expect(base?.get?.responses).toHaveProperty(status);
    for (const status of ['201', '400', '401', '403', '409', '415', '503']) {
      expect(base?.post?.responses).toHaveProperty(status);
    }
    for (const status of ['200', '400', '401', '403', '404', '409', '415', '503']) {
      expect(one?.put?.responses).toHaveProperty(status);
    }
    for (const status of ['200', '401', '403', '404', '503']) {
      expect(one?.delete?.responses).toHaveProperty(status);
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session and 403 without the view key, on every route', async () => {
      await boot();
      await seeded(code);
      const blind = sessionOf(code, NO_KEY, 2);
      const one = `/${id<'SavedFilter'>(0xd001)}`;

      for (const [method, path, body] of [
        ['get', `?listKey=${LIST}`, undefined],
        ['post', '', NEW],
        ['put', one, { name: 'X', visibility: 'me' }],
        ['delete', one, undefined],
      ] as const) {
        expect((await call(method, code, path, null).send(body)).status).toBe(401);
        expect((await call(method, code, path, blind).send(body)).status).toBe(403);
      }
      expect(store.rows.size).toBe(0);
    });

    it('refuses every write without the CSRF token', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);
      const one = `/${id<'SavedFilter'>(0xd001)}`;

      for (const [method, path, body] of [
        ['post', '', NEW],
        ['put', one, { name: 'X', visibility: 'me' }],
        ['delete', one, undefined],
      ] as const) {
        expect((await call(method, code, path, session, false).send(body)).status).toBe(403);
      }
      expect(store.rows.size).toBe(0);
    });

    it('lets a Viewer save a private filter and see it back with its count', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      const created = await call('post', code, '', session).send(NEW);
      const listed = await call('get', code, `?listKey=${LIST}`, session);

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        listKey: LIST,
        name: 'Lamb, active',
        visibility: 'me',
        ownedByMe: true,
        canManage: true,
        payload: PAYLOAD,
      });
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({
        canShare: false,
        limits: { perOwner: 50, shared: 20 },
        items: [{ id: idOf(created), name: 'Lamb, active', count: 7 }],
      });
    });

    it('refuses "everyone" to a Viewer with access.denied and accepts it from the Moderator', async () => {
      await boot();
      await seeded(code);

      const refused = await call('post', code, '', sessionOf(code, VIEWER, 1)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const accepted = await call('post', code, '', sessionOf(code, MODERATOR, 5)).send({
        ...NEW,
        visibility: 'everyone',
      });

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({ visibility: 'everyone' });
      expect(store.rows.size).toBe(1);
    });

    it('shows a shared filter to every admin who can see products, who cannot change or delete it', async () => {
      await boot();
      await seeded(code);
      const made = await call('post', code, '', sessionOf(code, MODERATOR, 5)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const viewer = sessionOf(code, OTHER_VIEWER, 6);
      const filter = `/${idOf(made)}`;

      const listed = await call('get', code, `?listKey=${LIST}`, viewer);
      const renamed = await call('put', code, filter, viewer).send({
        name: 'Mine',
        visibility: 'everyone',
      });
      const deleted = await call('delete', code, filter, viewer);

      expect(listed.body).toMatchObject({
        items: [
          { name: 'Lamb, active', visibility: 'everyone', ownedByMe: false, canManage: false },
        ],
      });
      expect(renamed.status).toBe(403);
      expect(deleted.status).toBe(403);
      expect(store.rows.size).toBe(1);
    });

    it('lets another Moderator rename and delete a filter somebody else shared', async () => {
      await boot();
      await seeded(code);
      const made = await call('post', code, '', sessionOf(code, VIEWER, 1)).send(NEW);
      // A Viewer's private filter is invisible to a Moderator: the same answer as an unknown id.
      const filter = `/${idOf(made)}`;
      expect((await call('delete', code, filter, sessionOf(code, MODERATOR, 5))).status).toBe(404);
      const shared = await call('post', code, '', sessionOf(code, MODERATOR, 5)).send({
        ...NEW,
        name: 'Shared',
        visibility: 'everyone',
      });
      const sharedPath = `/${idOf(shared)}`;
      seedAdmin(code, id<'Account'>(0xa006), 'm2', 'seed:catalogue-moderator', 8);
      const second = sessionOf(code, id<'Account'>(0xa006), 7);

      const renamed = await call('put', code, sharedPath, second).send({
        name: 'Renamed by another',
        visibility: 'everyone',
      });
      const deleted = await call('delete', code, sharedPath, second);

      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        name: 'Renamed by another',
        ownedByMe: false,
        canManage: true,
      });
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ id: idOf(shared) });
      expect([...store.rows.values()].map((r) => r.name)).toEqual(['Lamb, active']);
    });

    it('answers 409 for a repeated name and 400 naming the field for a bad body', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);
      await call('post', code, '', session).send(NEW);

      const repeated = await call('post', code, '', session).send({ ...NEW, name: 'LAMB, ACTIVE' });
      expect(repeated.status).toBe(409);
      expect(repeated.body).toMatchObject({ code: 'saved-filter.name-taken' });

      for (const [body, path] of [
        [{ ...NEW, extra: 1 }, 'extra'],
        [{ name: 'x', visibility: 'me', payload: PAYLOAD }, 'listKey'],
      ] as const) {
        const response = await call('post', code, '', session).send(body);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
      const unknownInPayload = await call('post', code, '', session).send({
        ...NEW,
        name: 'Other',
        payload: { ...PAYLOAD, columns: ['code'] },
      });
      expect(unknownInPayload.status).toBe(400);
      expect(unknownInPayload.body).toMatchObject({
        details: { fields: [{ path: 'payload.columns', code: 'unknown' }] },
      });
      const wrongType = await call('post', code, '', session)
        .set('content-type', 'text/plain')
        .send('name=x');
      expect(wrongType.status).toBe(415);
    });

    it('answers 400 for a list query with a missing or unknown list', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const query of ['', '?listKey=admin.orders', `?listKey=${LIST}&page=2`]) {
        const response = await call('get', code, query, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: 'validation.failed' });
      }
    });

    it('answers 404 for a malformed id on update and delete', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      expect(
        (await call('put', code, '/nope', session).send({ name: 'x', visibility: 'me' })).status,
      ).toBe(404);
      expect((await call('delete', code, '/nope', session)).status).toBe(404);
    });
  });

  it('never shows one Market’s filters to another, nor lets one change them', async () => {
    const [au, other] = TEST_MARKETS as readonly [string, string];
    await boot();
    await seeded(au);
    await seedRoles(other);
    const MODERATOR_THERE = id<'Account'>(0xa0f5);
    seedAdmin(other, MODERATOR_THERE, 'there', 'seed:catalogue-moderator', 9);
    const made = await call('post', au, '', sessionOf(au, MODERATOR, 5)).send({
      ...NEW,
      visibility: 'everyone',
    });

    expect(made.status).toBe(201);
    const listed = await call(
      'get',
      other,
      `?listKey=${LIST}`,
      sessionOf(other, MODERATOR_THERE, 9),
    );
    const deleted = await call(
      'delete',
      other,
      `/${idOf(made)}`,
      sessionOf(other, MODERATOR_THERE, 9),
    );

    expect(listed.body).toMatchObject({ items: [] });
    expect(deleted.status).toBe(404);
    expect(store.rows.size).toBe(1);
  });
});
