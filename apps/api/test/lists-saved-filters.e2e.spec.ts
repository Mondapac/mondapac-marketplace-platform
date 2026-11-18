import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SAVED_FILTER_STORE } from '../src/modules/lists/contracts';
import { SAVED_FILTER_STATUS } from '../src/modules/lists/presentation/saved-filter.controller';
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
import { MemorySavedFilterStore } from './support/lists-fakes';
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
const ORDERS = 'admin.ordering.orders';

it('maps the refusal codes of the saved-filter routes to their statuses', () => {
  expect(SAVED_FILTER_STATUS).toEqual({
    'validation.failed': 400,
    'saved-filter.not-found': 404,
    'saved-filter.name-taken': 409,
    'saved-filter.limit-reached': 409,
    'saved-filter.shared-limit-reached': 409,
    'access.unavailable': 503,
    'access.acting-as-refused': 403,
  });
});

describe('generic saved filters over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let store: MemorySavedFilterStore;
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
          .overrideProvider(SAVED_FILTER_STORE)
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
      [method](`/lists/admin/saved-filters${path}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
        ...(session !== null && withCsrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
      });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new MemorySavedFilterStore();
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
    const base = document.paths['/lists/admin/saved-filters'];
    const order = document.paths['/lists/admin/saved-filters/order'];
    const one = document.paths['/lists/admin/saved-filters/{id}'];
    for (const status of ['200', '400', '401', '403', '503'])
      expect(base?.get?.responses).toHaveProperty(status);
    for (const status of ['201', '400', '401', '403', '409', '415', '503'])
      expect(base?.post?.responses).toHaveProperty(status);
    for (const status of ['200', '400', '401', '403', '415', '503'])
      expect(order?.put?.responses).toHaveProperty(status);
    for (const status of ['200', '400', '401', '403', '404', '409', '415', '503'])
      expect(one?.put?.responses).toHaveProperty(status);
    for (const status of ['200', '401', '403', '404', '503'])
      expect(one?.delete?.responses).toHaveProperty(status);
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session and 403 without the list view key, on every route', async () => {
      await boot();
      await seeded(code);
      const blind = sessionOf(code, NO_KEY, 2);
      const one = `/${id<'SavedFilter'>(0xd001)}`;

      for (const [method, path, body] of [
        ['get', `?listKey=${LIST}`, undefined],
        ['post', '', NEW],
        ['put', '/order', { listKey: LIST, ids: [] }],
        ['put', one, { listKey: LIST, name: 'X', visibility: 'me' }],
        ['delete', `${one}?listKey=${LIST}`, undefined],
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
        ['put', '/order', { listKey: LIST, ids: [] }],
        ['put', one, { listKey: LIST, name: 'X', visibility: 'me' }],
        ['delete', `${one}?listKey=${LIST}`, undefined],
      ] as const) {
        expect((await call(method, code, path, session, false).send(body)).status).toBe(403);
      }
      expect(store.rows.size).toBe(0);
    });

    it('saves, lists, reorders and deletes a private filter', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      const first = await call('post', code, '', session).send(NEW);
      const second = await call('post', code, '', session).send({ ...NEW, name: 'Second' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const reordered = await call('put', code, '/order', session).send({
        listKey: LIST,
        ids: [idOf(second), idOf(first)],
      });
      const listed = await call('get', code, `?listKey=${LIST}`, session);
      const removed = await call('delete', code, `/${idOf(first)}?listKey=${LIST}`, session);

      expect(reordered.status).toBe(200);
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect((listed.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
        idOf(second),
        idOf(first),
      ]);
      expect(removed.status).toBe(200);
      expect(store.rows.size).toBe(1);
    });

    it('refuses a reorder that leaves out one of the caller own filters', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);
      const first = await call('post', code, '', session).send(NEW);
      await call('post', code, '', session).send({ ...NEW, name: 'Second' });

      const refused = await call('put', code, '/order', session).send({
        listKey: LIST,
        ids: [idOf(first)],
      });

      expect(refused.status).toBe(400);
    });

    it('refuses "everyone" to a Viewer and accepts it from the Moderator', async () => {
      await boot();
      await seeded(code);

      const refused = await call('post', code, '', sessionOf(code, VIEWER, 1)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const accepted = await call('post', code, '', sessionOf(code, MODERATOR, 3)).send({
        ...NEW,
        visibility: 'everyone',
      });

      expect(refused.status).toBe(403);
      expect(accepted.status).toBe(201);
    });

    it('keeps one list apart from another: a catalog Viewer cannot use the orders list, and an unknown list is a 400', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);
      const created = await call('post', code, '', session).send(NEW);

      const unknown = await call('post', code, '', session).send({
        ...NEW,
        listKey: 'admin.catalog.nothing',
      });
      const sellerList = await call('post', code, '', session).send({
        ...NEW,
        listKey: 'seller.catalog.products',
      });
      const wrongList = await call('delete', code, `/${idOf(created)}?listKey=${ORDERS}`, session);

      expect(unknown.status).toBe(400);
      expect(sellerList.status).toBe(400);
      expect([403, 404]).toContain(wrongList.status);
      expect(store.rows.size).toBe(1);
    });

    it.each([
      [
        'admin.ordering.shipments',
        {
          v: 1,
          tab: 'attention',
          filters: { deliveryMethod: 'pickup', attention: 'no-carrier', paid: 'last-7-days' },
          sort: 'paid',
          direction: 'desc',
        },
        { v: 1, filters: { shipped: '2026-11-01' } },
        'payload.filters.shipped',
      ],
      [
        'admin.ordering.refunds',
        {
          v: 1,
          tab: 'pending',
          filters: { reason: 'damaged', lossBearer: 'seller', requested: 'this-month' },
          sort: 'amount',
          direction: 'asc',
        },
        { v: 1, q: 'refund text' },
        'payload.q',
      ],
      [
        'admin.ordering.documents',
        { v: 1, tab: 'credit-note', filters: { issued: 'last-month' }, sort: 'issued' },
        { v: 2 },
        'payload.v',
      ],
    ] as const)(
      'gives the Sales list %s saved filters: create, list, reorder, update, delete, and a 400 for a bad payload',
      async (listKey, payload, badPayload, badPath) => {
        await boot();
        await seeded(code);
        const session = sessionOf(code, VIEWER, 1);
        const body = { listKey, name: 'Mine', visibility: 'me', payload };

        const first = await call('post', code, '', session).send(body);
        const second = await call('post', code, '', session).send({
          ...body,
          name: 'Second',
          payload: { v: 1 },
        });
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect((first.body as { payload: unknown }).payload).toEqual(payload);

        const reordered = await call('put', code, '/order', session).send({
          listKey,
          ids: [idOf(second), idOf(first)],
        });
        const updated = await call('put', code, `/${idOf(first)}`, session).send({
          listKey,
          name: 'Renamed',
          visibility: 'me',
        });
        const listed = await call('get', code, `?listKey=${listKey}`, session);

        expect(reordered.status).toBe(200);
        expect(updated.status).toBe(200);
        expect(listed.status).toBe(200);
        const items = (listed.body as { items: { id: string; name: string; payload: unknown }[] })
          .items;
        expect(items.map((i) => [i.id, i.name])).toEqual([
          [idOf(second), 'Second'],
          [idOf(first), 'Renamed'],
        ]);
        expect(items[1]!.payload).toEqual(payload);

        const shared = await call('post', code, '', session).send({
          ...body,
          name: 'For all',
          visibility: 'everyone',
        });
        expect(shared.status).toBe(403);

        const invalid = await call('post', code, '', session).send({
          ...body,
          name: 'Bad',
          payload: badPayload,
        });
        expect(invalid.status).toBe(400);
        expect(invalid.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path: badPath }] },
        });

        const removed = await call('delete', code, `/${idOf(first)}?listKey=${listKey}`, session);
        expect(removed.status).toBe(200);
        expect(store.rows.size).toBe(1);
        const left = await call('get', code, `?listKey=${listKey}`, session);
        expect((left.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
          idOf(second),
        ]);
      },
    );

    it('gives the System requests queue saved filters: its view key to save, its share key to share', async () => {
      await boot();
      await seeded(code);
      const roleWith = (n: number, keys: readonly string[]) => {
        const roleId = id<'Role'>(0xc100 + n);
        fakes.seedRole({
          id: roleId,
          marketId: code as AccountState['marketId'],
          scope: 'platform',
          kind: 'custom',
          seedCode: null,
          seedVersion: null,
          sellerId: null,
          name: `System requests ${n}`,
          permissionKeys: [...keys],
          version: 1,
          createdAt: START,
        });
        return roleId;
      };
      const QUEUE_VIEWER = id<'Account'>(0xa010);
      const QUEUE_SHARER = id<'Account'>(0xa011);
      seedAdmin(code, QUEUE_VIEWER, 'queue', roleWith(1, ['system-requests.request.view']), 10);
      seedAdmin(
        code,
        QUEUE_SHARER,
        'queue-share',
        roleWith(2, ['system-requests.request.view', 'system-requests.saved-filter.share']),
        11,
      );
      const listKey = 'admin.system-requests.requests';
      const payload = {
        v: 1,
        view: 'all-open',
        filters: { area: ['money', 'people'], risk: ['high'], overdue: true },
        sort: 'due',
        direction: 'asc',
      };
      const body = { listKey, name: 'Urgent money', visibility: 'me', payload };

      // The catalog Viewer does not see the queue, so it has no saved filters of it either.
      const outsider = await call('get', code, `?listKey=${listKey}`, sessionOf(code, VIEWER, 1));
      expect(outsider.status).toBe(403);

      const viewer = sessionOf(code, QUEUE_VIEWER, 10);
      const created = await call('post', code, '', viewer).send(body);
      expect(created.status).toBe(201);
      // Canonical form: the areas in the vocabulary's order.
      expect((created.body as { payload: unknown }).payload).toEqual({
        ...payload,
        filters: { area: ['people', 'money'], risk: ['high'], overdue: true },
      });
      const listed = await call('get', code, `?listKey=${listKey}`, viewer);
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ canShare: false, items: [{ name: 'Urgent money' }] });
      const shareRefused = await call('post', code, '', viewer).send({
        ...body,
        name: 'For all',
        visibility: 'everyone',
      });
      expect(shareRefused.status).toBe(403);
      const badPayload = await call('post', code, '', viewer).send({
        ...body,
        name: 'Search',
        payload: { v: 1, view: 'all', q: 'SR-1' },
      });
      expect(badPayload.status).toBe(400);
      expect(badPayload.body).toMatchObject({ details: { fields: [{ path: 'payload.q' }] } });

      const sharer = sessionOf(code, QUEUE_SHARER, 11);
      const shared = await call('post', code, '', sharer).send({
        ...body,
        name: 'For all',
        visibility: 'everyone',
      });
      expect(shared.status).toBe(201);
      const seenByViewer = await call('get', code, `?listKey=${listKey}`, viewer);
      expect(
        (seenByViewer.body as { items: { name: string }[] }).items.map((i) => i.name).sort(),
      ).toEqual(['For all', 'Urgent money']);
    });

    it('never shows a Market the filters of another', async () => {
      await boot();
      await seeded(code);
      const mine = await call('post', code, '', sessionOf(code, MODERATOR, 3)).send({
        ...NEW,
        visibility: 'everyone',
      });
      expect(mine.status).toBe(201);
      const otherCode = TEST_MARKETS.find((m) => m !== code)!;
      await seeded(otherCode);

      const listed = await call(
        'get',
        otherCode,
        `?listKey=${LIST}`,
        sessionOf(otherCode, VIEWER, 1),
      );

      expect(listed.status).toBe(200);
      expect((listed.body as { items: unknown[] }).items).toEqual([]);
    });
  });
});
