import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SELLER_SAVED_FILTER_REPOSITORY } from '../src/modules/catalog/application/ports/seller-saved-filter.repository';
import { SELLER_SAVED_FILTER_STATUS } from '../src/modules/catalog/presentation/seller-saved-filter.controller';
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
import { MemorySellerSavedFilters } from './support/saved-filter-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The saved filters of the seller Products list over HTTP (catalog design 9.2d): the real guards,
// controller, gates and use cases, with identity's ports and the filter store as in-memory fakes.
// Proved here: the seller session and the CSRF token, the view key (the seeded Customer Service
// role holds it and nothing more), the share key (the Seller Owner holds every seller key, so it
// holds the new one with no seed change), the closed body and payload, the statuses, who may change
// a filter a colleague shared, and that one store never sees or changes another store's filters.
// The SQL is in test/db/catalog-seller-saved-filters.db-spec.ts.

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
/** A store of the second Market (the identity fake keys seller access by seller id alone). */
const STORE_THERE = id<'Seller'>(0xb103);
const OWNER_A = id<'Account'>(0xa101);
const VIEWER_A = id<'Account'>(0xa102);
const OTHER_VIEWER_A = id<'Account'>(0xa103);
const NO_KEY_A = id<'Account'>(0xa104);
const OWNER_B = id<'Account'>(0xa201);
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

it('maps the refusal codes of the seller saved-filter routes to their statuses', () => {
  expect(SELLER_SAVED_FILTER_STATUS).toEqual({
    'validation.failed': 400,
    'saved-filter.not-found': 404,
    'saved-filter.name-taken': 409,
    'saved-filter.limit-reached': 409,
    'saved-filter.shared-limit-reached': 409,
    'access.acting-as-refused': 403,
    'access.unavailable': 503,
  });
});

describe('seller saved filters over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let store: MemorySellerSavedFilters;
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
          .overrideProvider(SELLER_SAVED_FILTER_REPOSITORY)
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
      [method](`/catalog/seller/saved-filters${path}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'seller'),
        ...(session === null ? {} : { cookie: session.cookie! }),
        ...(session !== null && withCsrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
      });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    store = new MemorySellerSavedFilters();
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
    const base = document.paths['/catalog/seller/saved-filters'];
    const one = document.paths['/catalog/seller/saved-filters/{id}'];
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
      const blind = noKeyA(code);
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
      const session = viewerA(code);
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

    it('does not take an admin session on the seller routes', async () => {
      await boot();
      await seeded(code);

      const answer = await http()
        .get(`/catalog/seller/saved-filters?listKey=${LIST}`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });

      expect(answer.status).toBe(401);
    });

    it('lets a view-only member save a private filter and see it back, in the stored shape', async () => {
      await boot();
      await seeded(code);
      const session = viewerA(code);

      const created = await call('post', code, '', session).send(NEW);
      const listed = await call('get', code, `?listKey=${LIST}`, session);

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: idOf(created),
        listKey: LIST,
        name: 'Live dates',
        visibility: 'me',
        payload: PAYLOAD,
        ownedByMe: true,
        canManage: true,
        createdAt: START.toString(),
        updatedAt: START.toString(),
      });
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toEqual({
        items: [created.body],
        canShare: false,
        limits: { perOwner: 50, shared: 20 },
      });
      expect([...store.rows.values()][0]).toMatchObject({ sellerId: STORE_A, marketId: code });
    });

    it('stores the document as the list reads it: defaults filled, empty values dropped', async () => {
      await boot();
      await seeded(code);

      const created = await call('post', code, '', viewerA(code)).send({
        ...NEW,
        payload: { v: 1, q: '  ', status: '' },
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        payload: { v: 1, view: 'all', sort: 'updated', direction: 'desc' },
      });
    });

    it('lets the Seller Owner share with the store (the owner holds the share key); a view-only member gets 403', async () => {
      await boot();
      await seeded(code);

      const refused = await call('post', code, '', viewerA(code)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const accepted = await call('post', code, '', ownerA(code)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const listed = await call('get', code, `?listKey=${LIST}`, ownerA(code));

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({ visibility: 'everyone' });
      expect(listed.body).toMatchObject({ canShare: true });
      expect(store.rows.size).toBe(1);
    });

    it('shows a shared filter to every member of the store, who cannot change or delete it without the share key', async () => {
      await boot();
      await seeded(code);
      const made = await call('post', code, '', ownerA(code)).send({
        ...NEW,
        visibility: 'everyone',
      });
      const viewer = otherViewerA(code);
      const filter = `/${idOf(made)}`;

      const listed = await call('get', code, `?listKey=${LIST}`, viewer);
      const renamed = await call('put', code, filter, viewer).send({
        name: 'Mine',
        visibility: 'everyone',
      });
      const deleted = await call('delete', code, filter, viewer);

      expect(listed.body).toMatchObject({
        items: [{ name: 'Live dates', visibility: 'everyone', ownedByMe: false, canManage: false }],
      });
      expect(renamed.status).toBe(403);
      expect(deleted.status).toBe(403);
      expect(store.rows.size).toBe(1);
    });

    it('hides a colleague’s private filter, even from the Seller Owner', async () => {
      await boot();
      await seeded(code);
      const made = await call('post', code, '', viewerA(code)).send(NEW);
      const filter = `/${idOf(made)}`;
      const owner = ownerA(code);

      const listed = await call('get', code, `?listKey=${LIST}`, owner);
      const renamed = await call('put', code, filter, owner).send({
        name: 'Mine',
        visibility: 'me',
      });
      const deleted = await call('delete', code, filter, owner);

      expect(listed.body).toMatchObject({ items: [] });
      expect(renamed.status).toBe(404);
      expect(deleted.status).toBe(404);
      expect(store.rows.size).toBe(1);
    });

    it('lets the owner of a filter rename and delete it, and a share-key holder rename and delete a colleague’s shared one', async () => {
      await boot();
      await seeded(code);
      const mine = await call('post', code, '', viewerA(code)).send(NEW);
      const shared = await call('post', code, '', ownerA(code)).send({
        ...NEW,
        name: 'Shared',
        visibility: 'everyone',
      });

      const renamedOwn = await call('put', code, `/${idOf(mine)}`, viewerA(code)).send({
        name: 'Renamed',
        visibility: 'me',
      });
      const deletedOwn = await call('delete', code, `/${idOf(mine)}`, viewerA(code));
      // A second Owner-like member: the owner themself, from another session.
      const renamedShared = await call('put', code, `/${idOf(shared)}`, ownerA(code)).send({
        name: 'Shared, renamed',
        visibility: 'everyone',
      });
      const deletedShared = await call('delete', code, `/${idOf(shared)}`, ownerA(code));

      expect(renamedOwn.status).toBe(200);
      expect(renamedOwn.body).toMatchObject({ name: 'Renamed', ownedByMe: true });
      expect(deletedOwn.status).toBe(200);
      expect(deletedOwn.body).toEqual({ id: idOf(mine) });
      expect(renamedShared.status).toBe(200);
      expect(deletedShared.status).toBe(200);
      expect(store.rows.size).toBe(0);
    });

    it('never shows, changes or deletes another store’s filters (404, the same as an unknown id)', async () => {
      await boot();
      await seeded(code);
      const theirPrivate = await call('post', code, '', ownerB(code)).send({
        ...NEW,
        name: 'B private',
      });
      const theirShared = await call('post', code, '', ownerB(code)).send({
        ...NEW,
        name: 'B shared',
        visibility: 'everyone',
      });
      const mine = await call('post', code, '', ownerA(code)).send({ ...NEW, name: 'A mine' });

      const listA = await call('get', code, `?listKey=${LIST}`, ownerA(code));
      const listB = await call('get', code, `?listKey=${LIST}`, ownerB(code));
      expect(listA.body).toMatchObject({ items: [{ name: 'A mine' }] });
      expect((listA.body as { items: unknown[] }).items).toHaveLength(1);
      expect((listB.body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
        'B private',
        'B shared',
      ]);

      for (const target of [idOf(theirPrivate), idOf(theirShared)]) {
        const renamed = await call('put', code, `/${target}`, ownerA(code)).send({
          name: 'Hijacked',
          visibility: 'everyone',
        });
        const deleted = await call('delete', code, `/${target}`, ownerA(code));
        expect(renamed.status).toBe(404);
        expect(renamed.body).toMatchObject({ code: 'saved-filter.not-found' });
        expect(deleted.status).toBe(404);
      }
      // B cannot reach A's either, and nothing changed.
      expect((await call('delete', code, `/${idOf(mine)}`, ownerB(code))).status).toBe(404);
      expect([...store.rows.values()].map((r) => r.name).sort()).toEqual([
        'A mine',
        'B private',
        'B shared',
      ]);
    });

    it('lets two stores share the same filter name', async () => {
      await boot();
      await seeded(code);
      const body = { ...NEW, visibility: 'everyone' };

      expect((await call('post', code, '', ownerA(code)).send(body)).status).toBe(201);
      expect((await call('post', code, '', ownerB(code)).send(body)).status).toBe(201);
      expect((await call('post', code, '', ownerA(code)).send(body)).status).toBe(409);
    });

    it('takes the store from the session: a sellerId in the body is a 400', async () => {
      await boot();
      await seeded(code);

      const response = await call('post', code, '', ownerA(code)).send({
        ...NEW,
        sellerId: STORE_B,
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      expect(store.rows.size).toBe(0);
    });

    it('answers 409 for a repeated name and 400 naming the field for a bad body', async () => {
      await boot();
      await seeded(code);
      const session = viewerA(code);
      await call('post', code, '', session).send(NEW);

      const repeated = await call('post', code, '', session).send({ ...NEW, name: 'LIVE DATES' });
      expect(repeated.status).toBe(409);
      expect(repeated.body).toMatchObject({ code: 'saved-filter.name-taken' });

      for (const [body, path] of [
        [{ ...NEW, extra: 1 }, 'extra'],
        [{ name: 'x', visibility: 'me', payload: PAYLOAD }, 'listKey'],
        [{ ...NEW, listKey: 'admin.catalog.products' }, 'listKey'],
        [{ ...NEW, listKey: 'seller-products' }, 'listKey'],
        [{ ...NEW, name: 'y', visibility: 'team' }, 'visibility'],
      ] as const) {
        const response = await call('post', code, '', session).send(body);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
      for (const [payload, path, fieldCode] of [
        [{ ...PAYLOAD, page: 2 }, 'payload.page', 'unknown'],
        [{ ...PAYLOAD, view: 'archived' }, 'payload.view', 'value'],
        [{ ...PAYLOAD, status: 'withdrawn' }, 'payload.status', 'value'],
        [{ ...PAYLOAD, categoryId: 'meat' }, 'payload.categoryId', 'format'],
        [{ ...PAYLOAD, paused: 'no' }, 'payload.paused', 'value'],
        [{ ...PAYLOAD, v: 2 }, 'payload.v', 'value'],
      ] as const) {
        const response = await call('post', code, '', session).send({
          ...NEW,
          name: 'Other',
          payload,
        });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          details: { fields: [{ path, code: fieldCode }] },
        });
      }
      const wrongType = await call('post', code, '', session)
        .set('content-type', 'text/plain')
        .send('name=x');
      expect(wrongType.status).toBe(415);
      expect(store.rows.size).toBe(1);
    });

    it('answers 400 for a list query with a missing, unknown or admin list or an extra key', async () => {
      await boot();
      await seeded(code);
      const session = viewerA(code);

      for (const query of [
        '',
        '?listKey=seller.orders',
        '?listKey=admin.catalog.products',
        `?listKey=${LIST}&page=2`,
      ]) {
        const response = await call('get', code, query, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: 'validation.failed' });
      }
    });

    it('answers 404 for an unknown or malformed id on update and delete', async () => {
      await boot();
      await seeded(code);
      const session = viewerA(code);

      for (const target of ['/nope', `/${id<'SavedFilter'>(0xd999)}`]) {
        expect(
          (await call('put', code, target, session).send({ name: 'x', visibility: 'me' })).status,
        ).toBe(404);
        expect((await call('delete', code, target, session)).status).toBe(404);
      }
    });

    it('answers 409 when the per-member cap is reached', async () => {
      await boot();
      await seeded(code);
      const session = viewerA(code);
      for (let n = 1; n <= 50; n++) {
        expect(
          (await call('post', code, '', session).send({ ...NEW, name: `Filter ${n}` })).status,
        ).toBe(201);
      }

      const over = await call('post', code, '', session).send({ ...NEW, name: 'One more' });

      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({
        code: 'saved-filter.limit-reached',
        details: { max: 50 },
      });
    }, 60_000);
  });

  it('never shows one Market’s filters to another, nor lets one change them', async () => {
    const [au, other] = TEST_MARKETS as readonly [string, string];
    await boot();
    await seeded(au);
    await seedRoles(other, [STORE_THERE]);
    const OWNER_THERE = id<'Account'>(0xa3f5);
    seedMember(other, OWNER_THERE, STORE_THERE, 'there', 'seed:seller-owner', 9);
    const made = await call('post', au, '', ownerA(au)).send({ ...NEW, visibility: 'everyone' });

    expect(made.status).toBe(201);
    const there = sessionOf(other, OWNER_THERE, STORE_THERE, 9);
    const listed = await call('get', other, `?listKey=${LIST}`, there);
    const deleted = await call('delete', other, `/${idOf(made)}`, there);

    expect(listed.body).toMatchObject({ items: [] });
    expect(deleted.status).toBe(404);
    expect(store.rows.size).toBe(1);
  });
});
