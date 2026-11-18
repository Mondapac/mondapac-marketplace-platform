import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SAVED_FILTER_STORE } from '../src/modules/lists/contracts';
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

// The saved filters of the seller lists over HTTP on the shared lists routes (B0-1b, seller side): the real guards,
// controller, gates and use cases, with identity's ports and the filter store as in-memory fakes.
// Proved here: the seller session and the CSRF token, the view key (the seeded Customer Service
// role holds it and nothing more), the share key (the Seller Owner holds every seller key, so it
// holds the new one with no seed change), the closed body and payload, the statuses, who may change
// a filter a colleague shared, and that one store never sees or changes another store's filters.
// The SQL is in test/db/lists-seller-saved-filters.db-spec.ts.

const START = Temporal.Instant.from('2026-11-07T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const LIST = 'seller.catalog.products';
/** The id a create answered (the HTTP body is untyped). */
const idOf = (response: { readonly body: unknown }): string => (response.body as { id: string }).id;

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const STORE_A = id<'Seller'>(0xb101);
const STORE_B = id<'Seller'>(0xb102);
const OWNER_A = id<'Account'>(0xa101);
const VIEWER_A = id<'Account'>(0xa102);
const OTHER_VIEWER_A = id<'Account'>(0xa103);
const NO_KEY_A = id<'Account'>(0xa104);
const OWNER_B = id<'Account'>(0xa201);
const ADMIN = id<'Account'>(0xa301);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const PAYLOAD = {
  v: 1,
  view: 'live',
  q: 'dates',
  status: 'published',
  paused: false,
  sort: 'name',
  direction: 'asc',
};
const NEW = { listKey: LIST, name: 'Live dates', visibility: 'me', payload: PAYLOAD };
const ORDERS = 'seller.ordering.orders';
const ORDER_NEW = {
  listKey: ORDERS,
  name: 'To ship',
  visibility: 'me',
  payload: { v: 1, tab: 'to-ship' },
};

describe('seller saved filters over HTTP (integration)', () => {
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

  /** An active member of a store holding the seeded seller role `role` (or a role of its own). */
  function seedMember(
    code: string,
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'>,
    label: string,
    role: string | Id<'Role'>,
    n: number,
  ) {
    const marketId = code as AccountState['marketId'];
    const roleId =
      typeof role === 'string' && role.startsWith('seed:')
        ? [...fakes.roles.values()].find(
            (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === role.slice(5),
          )!.id
        : (role as Id<'Role'>);
    fakes.seedAccount({
      id: accountId,
      marketId,
      population: 'seller',
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
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf000 + n),
      marketId,
      accountId,
      sellerId,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }

  async function seedRoles(code: string, stores: readonly Id<'Seller'>[] = [STORE_A, STORE_B]) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'filters-0001'), {});
    for (const sellerId of stores) {
      fakes.seedSellerAccess({
        sellerId,
        marketId: code as AccountState['marketId'],
        origin: 'self',
        state: 'approved',
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: 3,
        createdAt: START,
      });
    }
  }

  async function seeded(code: string) {
    await seedRoles(code);
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId: code as AccountState['marketId'],
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: STORE_A,
      name: 'No catalog key',
      permissionKeys: ['identity.team-member.view'],
      version: 1,
      createdAt: START,
    });
    seedMember(code, OWNER_A, STORE_A, 'ownera', 'seed:seller-owner', 1);
    seedMember(code, VIEWER_A, STORE_A, 'viewera', 'seed:customer-service', 2);
    seedMember(code, OTHER_VIEWER_A, STORE_A, 'viewera2', 'seed:customer-service', 3);
    seedMember(code, NO_KEY_A, STORE_A, 'nokeya', NO_KEY_ROLE, 4);
    seedMember(code, OWNER_B, STORE_B, 'ownerb', 'seed:seller-owner', 5);
    fakes.seedAccount({
      id: ADMIN,
      marketId: code as AccountState['marketId'],
      population: 'admin',
      email: { typed: 'admin@Example.com', normalized: 'admin@example.com' },
      displayName: 'Name admin',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
  }

  function sessionOf(
    code: string,
    account: Id<'Account'>,
    sellerId: Id<'Seller'>,
    n: number,
  ): Record<string, string> {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'seller',
        sellerId,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const ownerA = (code: string) => sessionOf(code, OWNER_A, STORE_A, 1);
  /** A real admin session (cookie of the admin panel) for the routes that must refuse it. */
  function adminSession(code: string): Record<string, string> {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf1ff),
        marketId: code as AccountState['marketId'],
        accountId: ADMIN,
        population: 'admin',
        sellerId: null,
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
  const viewerA = (code: string) => sessionOf(code, VIEWER_A, STORE_A, 2);
  const otherViewerA = (code: string) => sessionOf(code, OTHER_VIEWER_A, STORE_A, 3);
  const noKeyA = (code: string) => sessionOf(code, NO_KEY_A, STORE_A, 4);
  const ownerB = (code: string) => sessionOf(code, OWNER_B, STORE_B, 5);

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    code: string,
    path: string,
    session: Record<string, string> | null,
    withCsrf = true,
  ) =>
    http()
      [method](`/lists/seller/saved-filters${path}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'seller'),
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
  it('documents the five seller routes and their error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const base = document.paths['/lists/seller/saved-filters'];
    const one = document.paths['/lists/seller/saved-filters/{id}'];
    const order = document.paths['/lists/seller/saved-filters/order'];
    for (const status of ['200', '400', '401', '403', '503'])
      expect(base?.get?.responses).toHaveProperty(status);
    for (const status of ['201', '400', '401', '403', '409', '415', '503'])
      expect(base?.post?.responses).toHaveProperty(status);
    for (const status of ['200', '400', '401', '403', '404', '409', '415', '503'])
      expect(one?.put?.responses).toHaveProperty(status);
    for (const status of ['200', '401', '403', '404', '503'])
      expect(one?.delete?.responses).toHaveProperty(status);
    expect(order?.put?.responses).toHaveProperty('200');
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session and 403 without the view key, on every route', async () => {
      await boot();
      await seeded(code);
      const blind = noKeyA(code);
      const one = `/${id<'SavedFilter'>(0xd001)}`;
      for (const [method, path, body] of [
        ['get', `?listKey=${LIST}`, undefined],
        ['post', '', NEW],
        ['put', '/order', { listKey: LIST, ids: [] }],
        ['put', one, { listKey: LIST, name: 'X', visibility: 'me' }],
        ['delete', `${one}?listKey=${LIST}`, undefined],
      ] as const) {
        expect((await call(method, code, path, null).send(body)).status).toBe(401);
        const refused = await call(method, code, path, blind).send(body);
        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.body)).toContain('access.denied');
      }
      expect(store.rows.size).toBe(0);
    });

    it('refuses every write without the CSRF token and an admin session on the seller routes', async () => {
      await boot();
      await seeded(code);
      const session = viewerA(code);
      const one = `/${id<'SavedFilter'>(0xd001)}`;
      for (const [method, path, body] of [
        ['post', '', NEW],
        ['put', '/order', { listKey: LIST, ids: [] }],
        ['put', one, { listKey: LIST, name: 'X', visibility: 'me' }],
        ['delete', `${one}?listKey=${LIST}`, undefined],
      ] as const) {
        const refused = await call(method, code, path, session, false).send(body);
        expect(refused.status).toBe(403);
        expect(JSON.stringify(refused.body)).toContain('request.csrf');
      }
      const admin = adminSession(code);
      const asAdmin = await http()
        .get(`/lists/seller/saved-filters?listKey=${LIST}`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), cookie: admin.cookie! });
      const adminOnSeller = await http()
        .get(`/lists/seller/saved-filters?listKey=${LIST}`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), cookie: admin.cookie! });
      expect(asAdmin.status).toBe(401);
      expect([401, 403]).toContain(adminOnSeller.status);
      expect(store.rows.size).toBe(0);
    });

    it('saves a private filter, lists it back and keeps it from a colleague', async () => {
      await boot();
      await seeded(code);
      const created = await call('post', code, '', viewerA(code)).send(NEW);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ listKey: LIST, name: 'Live dates', visibility: 'me' });
      const mine = await call('get', code, `?listKey=${LIST}`, viewerA(code));
      const theirs = await call('get', code, `?listKey=${LIST}`, otherViewerA(code));
      expect((mine.body as { items: unknown[] }).items).toHaveLength(1);
      expect((theirs.body as { items: unknown[] }).items).toEqual([]);
    });

    it('lets the Seller Owner share with the store and refuses a view-only member', async () => {
      await boot();
      await seeded(code);
      const refused = await call('post', code, '', viewerA(code)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const shared = await call('post', code, '', ownerA(code)).send({
        ...NEW,
        visibility: 'everyone',
      });
      expect(refused.status).toBe(403);
      expect(shared.status).toBe(201);
      const seen = await call('get', code, `?listKey=${LIST}`, otherViewerA(code));
      expect((seen.body as { items: unknown[] }).items).toHaveLength(1);
      const otherStore = await call('get', code, `?listKey=${LIST}`, ownerB(code));
      expect((otherStore.body as { items: unknown[] }).items).toEqual([]);
    });

    it('answers 404 for another store’s filter id on update and delete, like an unknown id', async () => {
      await boot();
      await seeded(code);
      const created = await call('post', code, '', ownerA(code)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const filter = idOf(created);
      const update = await call('put', code, `/${filter}`, ownerB(code)).send({
        listKey: LIST,
        name: 'Taken over',
        visibility: 'me',
      });
      const remove = await call('delete', code, `/${filter}?listKey=${LIST}`, ownerB(code));
      expect(update.status).toBe(404);
      expect(remove.status).toBe(404);
      expect(store.rows.size).toBe(1);
      expect([...store.rows.values()].map((row) => row.filter.name)).toEqual(['Live dates']);
    });

    it('reads `order` as the reorder route, not as an id', async () => {
      await boot();
      await seeded(code);
      const session = ownerA(code);
      const one = idOf(await call('post', code, '', session).send(NEW));
      const two = idOf(await call('post', code, '', session).send({ ...NEW, name: 'Second' }));
      const answer = await call('put', code, '/order', session).send({
        listKey: LIST,
        ids: [two, one],
      });
      expect(answer.status).toBe(200);
      const listed = await call('get', code, `?listKey=${LIST}`, session);
      expect((listed.body as { items: { name: string }[] }).items.map((item) => item.name)).toEqual(
        ['Second', 'Live dates'],
      );
    });

    it('keeps the seller Orders filter for the account with no store and never shares it', async () => {
      await boot();
      await seeded(code);
      const session = ownerA(code);
      expect((await call('post', code, '', session).send(ORDER_NEW)).status).toBe(201);
      const shared = await call('post', code, '', session).send({
        ...ORDER_NEW,
        name: 'S',
        visibility: 'everyone',
      });
      expect(shared.status).toBe(403);
      const rows = [...store.rows.values()];
      expect(rows.map((row) => row.filter.sellerId)).toEqual([null]);
      const seen = await call('get', code, `?listKey=${ORDERS}`, session);
      expect((seen.body as { items: unknown[]; canShare: boolean }).canShare).toBe(false);
      expect((seen.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('answers 400 for an admin list, an unknown key, an unknown field or a bad body', async () => {
      await boot();
      await seeded(code);
      const session = ownerA(code);
      for (const body of [
        { ...NEW, listKey: 'admin.catalog.products' },
        { ...NEW, listKey: 'seller.catalog.unknown' },
        { ...NEW, sellerId: STORE_B },
        { ...NEW, payload: { v: 2 } },
      ]) {
        expect((await call('post', code, '', session).send(body)).status).toBe(400);
      }
      expect(store.rows.size).toBe(0);
    });
  });
});
