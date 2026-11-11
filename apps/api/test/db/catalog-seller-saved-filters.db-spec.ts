import { ok, parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { OwnSavedFilterCreate } from '../../src/modules/catalog/application/use-cases/own-saved-filter-create.use-case';
import { OwnSavedFilterDelete } from '../../src/modules/catalog/application/use-cases/own-saved-filter-delete.use-case';
import { OwnSavedFilterShareCheck } from '../../src/modules/catalog/application/use-cases/own-saved-filter-share-check.use-case';
import { OwnSavedFilterUpdate } from '../../src/modules/catalog/application/use-cases/own-saved-filter-update.use-case';
import { OwnSavedFiltersList } from '../../src/modules/catalog/application/use-cases/own-saved-filters-list.use-case';
import { CATALOG_AUDIT_ACTIONS } from '../../src/modules/catalog/domain/audit';
import { MAX_SAVED_FILTERS_PER_OWNER } from '../../src/modules/catalog/domain/saved-filter';
import { PrismaSavedFilterRepository } from '../../src/modules/catalog/infrastructure/prisma-saved-filter.repository';
import { PrismaSellerSavedFilterRepository } from '../../src/modules/catalog/infrastructure/prisma-seller-saved-filter.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ids } from './outbox-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The saved filters of the seller Products list on PostgreSQL as the application role, in both
// Market fixtures (catalog data design 3.28; design 9.2d): the real use cases on the real unit of
// work and the real audit writer create, list, rename, share and delete filters inside one store;
// the table's CHECK ties a `seller.` list key to a store and an admin key to none; the four
// case-insensitive name uniques hold per store; the 50-per-member cap holds against rows written
// around the use case; the role cannot move a filter to another store; and no store, no Market and
// no admin route reads or changes another's rows.

const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');
const CHECK = '23514';
const UNIQUE = '23505';
const DENIED = '42501';
const LIST = 'seller.catalog.products';
const ADMIN_LIST = 'admin.catalog.products';
const VIEW = 'catalog.own-product.view';
const SHARE = 'catalog.own-saved-filter.share';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const PAYLOAD = { v: 1, view: 'live', q: 'dates', sort: 'name', direction: 'asc' };
let counter = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10)));
/** A name no other run of this spec used: shared names are unique per store and list. */
const unique = (name: string): string => `${name} ${uuid7().slice(-8)}`;
const account = (): Id<'Account'> => {
  const parsed = parseId<'Account'>(uuid7());
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};
const store = (): Id<'Seller'> => uuid7() as Id<'Seller'>;

describe.each(TEST_MARKETS)('seller saved filters in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const held = new Map<string, readonly string[]>();
  const check: AuthorisationCheck = {
    check: (context, declaration) => {
      const keys =
        context.actor.kind === 'authenticated' ? (held.get(context.actor.accountId) ?? []) : [];
      const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
      return Promise.resolve(
        needs.every((key) => keys.includes(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };
  const gate = createUseCaseGate(markets, check);
  let db: Persistence;
  let owner: Client;
  let app: Client;
  let audit: AuditWriter;
  let sellerRepo: PrismaSellerSavedFilterRepository;
  let adminRepo: PrismaSavedFilterRepository;
  let create: OwnSavedFilterCreate;
  let update: OwnSavedFilterUpdate;
  let remove: OwnSavedFilterDelete;
  let list: OwnSavedFiltersList;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    app = new Client({ connectionString: testDatabaseUrl() });
    await Promise.all([owner.connect(), app.connect()]);
    // The real audit writer: the audit row commits with the change, as in production.
    const catalogue = new AuditActionCatalogue();
    catalogue.register('catalog', CATALOG_AUDIT_ACTIONS);
    catalogue.seal();
    audit = PersistenceModule.auditWriterFor('catalog').useFactory(
      catalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    sellerRepo = new PrismaSellerSavedFilterRepository(db.service);
    adminRepo = new PrismaSavedFilterRepository(db.service);
    const ownShareCheck = new OwnSavedFilterShareCheck(gate);
    const base = { unitOfWork: db.unitOfWork, sellerSavedFilters: sellerRepo, ownShareCheck };
    create = new OwnSavedFilterCreate(gate, { ...base, audit, clock, ids });
    update = new OwnSavedFilterUpdate(gate, { ...base, audit, clock });
    remove = new OwnSavedFilterDelete(gate, { ...base, audit });
    list = new OwnSavedFiltersList(gate, base);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), db.close()]);
    await db.close().catch(() => undefined);
  });

  const member = (
    keys: readonly string[],
    sellerId: Id<'Seller'>,
    target: MarketContext = market,
    accountId: Id<'Account'> = account(),
  ) => {
    held.set(accountId, keys);
    const context: CallContext = testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'seller',
        accountId,
        sessionId: uuid7() as Id<'Session'>,
        sellerId,
      }),
      'seller-filters-db-abcd',
    );
    return { accountId, sellerId, context };
  };
  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: LIST,
    name: 'Live dates',
    visibility: 'me',
    payload: PAYLOAD,
    ...overrides,
  });
  const idOf = (result: { ok: boolean }): string => {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return (result as unknown as { value: { id: string } }).value.id;
  };
  const namesOf = (result: unknown): string[] =>
    (result as { value: { items: { name: string }[] } }).value.items.map((item) => item.name);
  const rowsOf = async (target: MarketContext, sellerId: string) =>
    (
      await owner.query<{ id: string; name: string; visibility: string; position: number }>(
        `SELECT id, name, visibility, position FROM catalog.saved_filters
          WHERE market_id = $1 AND seller_id = $2 ORDER BY position, created_at, id`,
        [target.marketId, sellerId],
      )
    ).rows;
  const auditActions = async (target: MarketContext, targetId: string) =>
    (
      await owner.query<{ action: string; before: unknown; after: unknown; actor_id: string }>(
        `SELECT action, before, after, actor_id FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, id`,
        [target.marketId, targetId],
      )
    ).rows;
  const failure = (result: { ok: boolean; error?: { code: string } }) =>
    result.ok ? 'ok' : result.error?.code;

  it('creates, lists, renames, shares and deletes through the real unit, with audit rows only for shared filters', async () => {
    const shop = store();
    const boss = member([VIEW, SHARE], shop);
    const clerk = member([VIEW], shop);

    const sharedName = unique('Shared one');
    const privateId = idOf(await create.execute(boss.context, body({ name: 'Private one' })));
    const sharedId = idOf(
      await create.execute(boss.context, body({ name: sharedName, visibility: 'everyone' })),
    );
    const listed = await list.execute(clerk.context, { listKey: LIST });
    const renamedByClerk = await update.execute(clerk.context, {
      id: sharedId,
      name: 'Renamed',
      visibility: 'everyone',
    });
    const second = member([VIEW, SHARE], shop);
    const renamedBySecond = await update.execute(second.context, {
      id: sharedId,
      name: unique('Renamed'),
      visibility: 'everyone',
    });
    const privateToShared = await update.execute(boss.context, {
      id: privateId,
      name: 'Private one',
      visibility: 'everyone',
    });
    await remove.execute(second.context, { id: sharedId });
    await remove.execute(boss.context, { id: privateId });

    // The clerk sees the shared one, not the private one, in the stored shape.
    expect((listed as unknown as { value: { canShare: boolean } }).value.canShare).toBe(false);
    expect(
      (listed as unknown as { value: { items: Record<string, unknown>[] } }).value.items,
    ).toEqual([
      expect.objectContaining({
        id: sharedId,
        listKey: LIST,
        name: sharedName,
        visibility: 'everyone',
        ownedByMe: false,
        canManage: false,
        payload: PAYLOAD,
      }),
    ]);
    expect(failure(renamedByClerk)).toBe('access.denied');
    expect(failure(renamedBySecond)).toBe('ok');
    expect(failure(privateToShared)).toBe('ok');
    expect(await rowsOf(market, shop)).toEqual([]);

    expect((await auditActions(market, sharedId)).map((row) => row.action)).toEqual([
      'catalog.saved-filter.shared',
      'catalog.saved-filter.changed',
      'catalog.saved-filter.removed',
    ]);
    const [shared, changed] = await auditActions(market, sharedId);
    expect(shared).toMatchObject({
      actor_id: boss.accountId,
      after: { listKey: LIST, visibility: 'everyone' },
    });
    expect(changed).toMatchObject({
      before: { visibility: 'everyone' },
      after: { visibility: 'everyone', renamed: true, ownedByActor: false },
      actor_id: second.accountId,
    });
    // The private filter was audited only once it became shared and was then removed.
    expect((await auditActions(market, privateId)).map((row) => row.action)).toEqual([
      'catalog.saved-filter.changed',
      'catalog.saved-filter.removed',
    ]);
    expect(JSON.stringify(await auditActions(market, sharedId))).not.toContain(sharedName);
  });

  it('keeps one name per member, store and list whatever its case, one per store’s shared list, and rolls a refused rename back', async () => {
    const shop = store();
    const a = member([VIEW, SHARE], shop);
    const b = member([VIEW, SHARE], shop);
    const sharedLamb = unique('Dates for all');
    await create.execute(a.context, body({ name: 'Dates' }));

    expect(failure(await create.execute(a.context, body({ name: 'DATES' })))).toBe(
      'saved-filter.name-taken',
    );
    // Two members may keep the same private name…
    const bPrivate = idOf(await create.execute(b.context, body({ name: 'dates' })));
    // …but not the same shared name.
    const aShared = idOf(
      await create.execute(a.context, body({ name: sharedLamb, visibility: 'everyone' })),
    );
    expect(
      failure(
        await create.execute(
          b.context,
          body({ name: sharedLamb.toUpperCase(), visibility: 'everyone' }),
        ),
      ),
    ).toBe('saved-filter.name-taken');
    expect(
      failure(
        await update.execute(b.context, { id: bPrivate, name: sharedLamb, visibility: 'everyone' }),
      ),
    ).toBe('saved-filter.name-taken');
    // Another store may use the same shared name, and the same account the same private name in
    // two stores.
    const elsewhere = member([VIEW, SHARE], store());
    expect(
      failure(
        await create.execute(elsewhere.context, body({ name: sharedLamb, visibility: 'everyone' })),
      ),
    ).toBe('ok');
    const twoStores = account();
    const inFirst = member([VIEW], shop, market, twoStores);
    const inSecond = member([VIEW], store(), market, twoStores);
    expect(failure(await create.execute(inFirst.context, body({ name: 'Same name' })))).toBe('ok');
    expect(failure(await create.execute(inSecond.context, body({ name: 'Same name' })))).toBe('ok');
    // Nothing changed for b, and a's shared filter is intact.
    expect((await rowsOf(market, shop)).filter((row) => row.id === bPrivate)).toEqual([
      expect.objectContaining({ id: bPrivate, name: 'dates', visibility: 'me' }),
    ]);
    expect((await rowsOf(market, shop)).map((row) => row.id)).toContain(aShared);
  });

  it(`stops at ${MAX_SAVED_FILTERS_PER_OWNER} filters per member, store and list even when rows were written around the use case`, async () => {
    const shop = store();
    const a = member([VIEW], shop);
    for (let n = 1; n <= MAX_SAVED_FILTERS_PER_OWNER; n++) {
      await owner.query(
        `INSERT INTO catalog.saved_filters
           (id, market_id, tenant_id, owner_account_id, seller_id, visibility, list_key, name, payload, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'me', $6, $7, $8, $9, $10, $10)`,
        [
          uuid7(),
          market.marketId,
          market.tenantId,
          a.accountId,
          shop,
          LIST,
          `Bulk ${n}`,
          PAYLOAD,
          n,
          new Date(),
        ],
      );
    }

    expect(await create.execute(a.context, body({ name: 'Over the cap' }))).toEqual({
      ok: false,
      error: { code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER },
    });
    // The same account in another store is not held back by it.
    const inOther = member([VIEW], store(), market, a.accountId);
    expect(failure(await create.execute(inOther.context, body({ name: 'Fits' })))).toBe('ok');
    // A single delete makes room, and the new filter takes the next position.
    const first = (await rowsOf(market, shop))[0]!;
    await remove.execute(a.context, { id: first.id });
    expect(failure(await create.execute(a.context, body({ name: 'Fits now' })))).toBe('ok');
    expect((await rowsOf(market, shop)).at(-1)).toMatchObject({
      name: 'Fits now',
      position: MAX_SAVED_FILTERS_PER_OWNER + 1,
    });
  });

  it('never reads, lists, renames or deletes another store’s filters, private or shared', async () => {
    const shopA = store();
    const shopB = store();
    const a = member([VIEW, SHARE], shopA);
    const b = member([VIEW, SHARE], shopB);
    const canary = unique('Canary');
    const aPrivate = idOf(await create.execute(a.context, body({ name: unique('A private') })));
    const aShared = idOf(
      await create.execute(a.context, body({ name: canary, visibility: 'everyone' })),
    );

    const listed = await list.execute(b.context, { listKey: LIST });

    expect(namesOf(listed)).toEqual([]);
    for (const id of [aPrivate, aShared]) {
      expect(
        failure(await update.execute(b.context, { id, name: 'Hijacked', visibility: 'me' })),
      ).toBe('saved-filter.not-found');
      expect(failure(await remove.execute(b.context, { id }))).toBe('saved-filter.not-found');
    }
    expect((await rowsOf(market, shopA)).map((row) => row.id).sort()).toEqual(
      [aPrivate, aShared].sort(),
    );
    // The repository itself answers nothing for a foreign store, whatever the statement.
    const peek = await db.unitOfWork.run(market, async () =>
      ok({
        find: await sellerRepo.find(market, shopB, aShared as Id<'SavedFilter'>),
        owned: await sellerRepo.countOwnedBy(market, shopB, LIST, a.accountId),
        shared: await sellerRepo.countShared(market, shopB, LIST),
        gone: await sellerRepo.remove(market, shopB, aShared as Id<'SavedFilter'>),
      }),
    );
    expect(peek).toEqual({ ok: true, value: { find: null, owned: 0, shared: 0, gone: false } });
    expect((await rowsOf(market, shopA)).length).toBe(2);
  });

  it('never reads, lists, renames or deletes another Market’s filters', async () => {
    const shop = store();
    const here = member([VIEW, SHARE], shop);
    const there = member([VIEW, SHARE], shop, other);
    const canary = unique('Market canary');
    const sharedHere = idOf(
      await create.execute(here.context, body({ name: canary, visibility: 'everyone' })),
    );
    await create.execute(there.context, body({ name: canary, visibility: 'everyone' }));

    const listed = await list.execute(there.context, { listKey: LIST });

    expect(namesOf(listed).filter((name) => name === canary)).toHaveLength(1);
    expect(
      failure(
        await update.execute(there.context, { id: sharedHere, name: 'Taken', visibility: 'me' }),
      ),
    ).toBe('saved-filter.not-found');
    expect(failure(await remove.execute(there.context, { id: sharedHere }))).toBe(
      'saved-filter.not-found',
    );
    expect((await rowsOf(market, shop)).map((row) => row.name)).toContain(canary);
  });

  it('keeps admin and seller filters apart in both repositories', async () => {
    const shop = store();
    const boss = member([VIEW, SHARE], shop);
    const sellerId = idOf(
      await create.execute(
        boss.context,
        body({ name: unique('Seller one'), visibility: 'everyone' }),
      ),
    );
    const adminId = uuid7();
    await owner.query(
      `INSERT INTO catalog.saved_filters
         (id, market_id, tenant_id, owner_account_id, seller_id, visibility, list_key, name, payload, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 'everyone', $5, $6, $7, 1, now(), now())`,
      [
        adminId,
        market.marketId,
        market.tenantId,
        account(),
        ADMIN_LIST,
        unique('Admin one'),
        PAYLOAD,
      ],
    );

    const seen = await db.unitOfWork.run(market, async () => {
      const adminSide = await adminRepo.find(market, sellerId as Id<'SavedFilter'>);
      const sellerSide = await sellerRepo.find(market, shop, adminId as Id<'SavedFilter'>);
      const adminShared = await adminRepo.countShared(market, LIST);
      const adminChange = await adminRepo.change(market, {
        id: sellerId as Id<'SavedFilter'>,
        listKey: LIST,
        ownerAccountId: boss.accountId,
        sellerId: null,
        visibility: 'me',
        name: 'Hijacked',
        payload: PAYLOAD,
        position: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      const adminRemoved = await adminRepo.remove(market, sellerId as Id<'SavedFilter'>);
      return ok({ adminSide, sellerSide, adminShared, adminChange, adminRemoved });
    });

    expect(seen).toEqual({
      ok: true,
      value: {
        adminSide: null,
        sellerSide: null,
        adminShared: 0,
        adminChange: 'gone',
        adminRemoved: false,
      },
    });
    expect((await rowsOf(market, shop)).map((row) => row.id)).toEqual([sellerId]);
  });

  it('rolls a failed audit write back with the filter (one unit)', async () => {
    const shop = store();
    const boss = member([VIEW, SHARE], shop);
    const failing = new OwnSavedFilterCreate(gate, {
      unitOfWork: db.unitOfWork,
      sellerSavedFilters: sellerRepo,
      ownShareCheck: new OwnSavedFilterShareCheck(gate),
      audit: { record: () => Promise.reject(new Error('audit down')) },
      clock,
      ids,
    });

    await expect(
      failing.execute(boss.context, body({ name: unique('Rolled back'), visibility: 'everyone' })),
    ).rejects.toThrow();

    expect(await rowsOf(market, shop)).toEqual([]);
  });

  describe('the table as the application role', () => {
    const insertAs = (client: Client, overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        owner_account_id: account(),
        seller_id: store(),
        visibility: 'me',
        list_key: LIST,
        name: `Check ${uuid7()}`,
        payload: PAYLOAD,
        position: 1,
        created_at: new Date('2026-11-07T00:00:00Z'),
        updated_at: new Date('2026-11-07T00:00:00Z'),
        ...overrides,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO catalog.saved_filters (${columns.join(', ')})
         VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('takes a valid seller row and a valid admin row', async () => {
      await expect(insertAs(app)).resolves.toMatchObject({ rowCount: 1 });
      await expect(insertAs(app, { seller_id: null, list_key: ADMIN_LIST })).resolves.toMatchObject(
        { rowCount: 1 },
      );
    });

    it.each([
      ['a seller list key without a store', { seller_id: null }],
      ['an admin list key with a store', { list_key: ADMIN_LIST }],
      ['a list key in upper case', { list_key: 'Seller.Catalog.Products' }],
      ['a name with a leading space', { name: ' dates' }],
      ['another visibility', { visibility: 'team' }],
    ])('refuses %s (CHECK)', async (_label, overrides) => {
      await expect(insertAs(app, overrides)).rejects.toMatchObject({ code: CHECK });
    });

    it('refuses a name that differs only by case for one owner in one store, but not in two', async () => {
      const ownerAccountId = account();
      const shop = store();
      await insertAs(app, { owner_account_id: ownerAccountId, seller_id: shop, name: 'Case' });

      await expect(
        insertAs(app, { owner_account_id: ownerAccountId, seller_id: shop, name: 'CASE' }),
      ).rejects.toMatchObject({ code: UNIQUE });
      await expect(
        insertAs(app, { owner_account_id: ownerAccountId, name: 'CASE' }),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(insertAs(app, { seller_id: shop, name: 'CASE' })).resolves.toMatchObject({
        rowCount: 1,
      });
    });

    it('refuses a shared name that repeats inside one store, but not across stores or against a private one', async () => {
      const shop = store();
      await insertAs(app, { seller_id: shop, visibility: 'everyone', name: 'Shared check' });

      await expect(
        insertAs(app, { seller_id: shop, visibility: 'everyone', name: 'SHARED CHECK' }),
      ).rejects.toMatchObject({ code: UNIQUE });
      await expect(
        insertAs(app, { visibility: 'everyone', name: 'Shared check' }),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        insertAs(app, { seller_id: shop, visibility: 'me', name: 'Shared check' }),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it('keeps the admin name uniques on admin rows only', async () => {
      const ownerAccountId = account();
      const name = unique('Admin unique');
      await insertAs(app, {
        seller_id: null,
        list_key: ADMIN_LIST,
        owner_account_id: ownerAccountId,
        name,
        visibility: 'everyone',
      });

      await expect(
        insertAs(app, {
          seller_id: null,
          list_key: ADMIN_LIST,
          owner_account_id: ownerAccountId,
          name: name.toUpperCase(),
        }),
      ).rejects.toMatchObject({ code: UNIQUE });
      await expect(
        insertAs(app, {
          seller_id: null,
          list_key: ADMIN_LIST,
          visibility: 'everyone',
          name: name.toUpperCase(),
        }),
      ).rejects.toMatchObject({ code: UNIQUE });
    });

    it('has the access-path index of the store’s list', async () => {
      const indexes = await owner.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'catalog' AND tablename = 'saved_filters'`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'saved_filters_market_id_seller_id_list_key_idx',
          'saved_filters_owner_name_key',
          'saved_filters_shared_name_key',
          'saved_filters_seller_owner_name_key',
          'saved_filters_seller_shared_name_key',
        ]),
      );
    });

    it('lets the role change the name, visibility and update time, and delete, but never the store', async () => {
      const rowId = uuid7();
      await insertAs(app, { id: rowId, name: 'Grant check' });

      await expect(
        app.query(
          `UPDATE catalog.saved_filters SET name = 'Grant renamed', visibility = 'everyone', updated_at = now() WHERE id = $1`,
          [rowId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        app.query(`UPDATE catalog.saved_filters SET seller_id = $2 WHERE id = $1`, [
          rowId,
          store(),
        ]),
      ).rejects.toMatchObject({ code: DENIED });
      await expect(
        app.query(`UPDATE catalog.saved_filters SET seller_id = NULL WHERE id = $1`, [rowId]),
      ).rejects.toMatchObject({ code: DENIED });
      await expect(
        app.query(`DELETE FROM catalog.saved_filters WHERE id = $1`, [rowId]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
