import { parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SavedFilterCreate } from '../../src/modules/catalog/application/use-cases/saved-filter-create.use-case';
import { SavedFilterDelete } from '../../src/modules/catalog/application/use-cases/saved-filter-delete.use-case';
import { SavedFilterShareCheck } from '../../src/modules/catalog/application/use-cases/saved-filter-share-check.use-case';
import { SavedFilterUpdate } from '../../src/modules/catalog/application/use-cases/saved-filter-update.use-case';
import { SavedFiltersList } from '../../src/modules/catalog/application/use-cases/saved-filters-list.use-case';
import { CATALOG_AUDIT_ACTIONS } from '../../src/modules/catalog/domain/audit';
import { MAX_SAVED_FILTERS_PER_OWNER } from '../../src/modules/catalog/domain/saved-filter';
import { ConfigCatalogMarketPolicy } from '../../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { PrismaAdminProductsReader } from '../../src/modules/catalog/infrastructure/prisma-admin-products.reader';
import { PrismaSavedFilterRepository } from '../../src/modules/catalog/infrastructure/prisma-saved-filter.repository';
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

// The saved filters on PostgreSQL as the application role, in both Market fixtures (catalog data
// design 3.28; design 9.2d): the real use cases on the real unit of work and the real audit writer
// create, list, rename, share and delete filters; the table's CHECKs and the two case-insensitive
// name uniques hold; the 50-per-owner cap holds against rows written around the use case; the
// role can change a filter's name and visibility only; and no Market reads or changes another's.

const T0 = Temporal.Instant.from('2026-10-31T00:00:00Z');
const CHECK = '23514';
const UNIQUE = '23505';
const DENIED = '42501';
const LIST = 'admin.catalog.products';
const VIEW = 'catalog.product.view';
const SHARE = 'catalog.saved-filter.share';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const PAYLOAD = {
  v: 1,
  view: 'all',
  q: 'lamb',
  filters: { scope: 'SELLER' },
  sort: 'name',
  direction: 'asc',
};
let counter = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + counter++, crypto.getRandomValues(new Uint8Array(10)));
/** A name no other run of this spec used: shared names are unique per Market and list. */
const unique = (name: string): string => `${name} ${uuid7().slice(-8)}`;
const account = (): Id<'Account'> => {
  const parsed = parseId<'Account'>(uuid7());
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each(TEST_MARKETS)('catalog saved filters in market %s (database)', (code) => {
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
  let create: SavedFilterCreate;
  let update: SavedFilterUpdate;
  let remove: SavedFilterDelete;
  let list: SavedFiltersList;

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
    const savedFilters = new PrismaSavedFilterRepository(db.service);
    const shareCheck = new SavedFilterShareCheck(gate);
    const base = { unitOfWork: db.unitOfWork, savedFilters, shareCheck };
    create = new SavedFilterCreate(gate, { ...base, audit, clock, ids });
    update = new SavedFilterUpdate(gate, { ...base, audit, clock });
    remove = new SavedFilterDelete(gate, { ...base, audit });
    list = new SavedFiltersList(gate, {
      ...base,
      adminProductsReader: new PrismaAdminProductsReader(db.service),
      policy,
    });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), db.close()]);
    await db.close().catch(() => undefined);
  });

  const admin = (keys: readonly string[], target: MarketContext = market) => {
    const accountId = account();
    held.set(accountId, keys);
    const context: CallContext = testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: null,
      }),
      'saved-filters-db-abcd',
    );
    return { accountId, context };
  };
  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: LIST,
    name: 'Meat, active',
    visibility: 'me',
    payload: PAYLOAD,
    ...overrides,
  });
  const idOf = (result: { ok: boolean }): string => {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return (result as unknown as { value: { id: string } }).value.id;
  };
  const rowsOf = async (target: MarketContext, ownerAccountId: string) =>
    (
      await owner.query<{ id: string; name: string; visibility: string; position: number }>(
        `SELECT id, name, visibility, position FROM catalog.saved_filters
          WHERE market_id = $1 AND owner_account_id = $2 ORDER BY position`,
        [target.marketId, ownerAccountId],
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
    const mod = admin([VIEW, SHARE]);
    const viewer = admin([VIEW]);

    const sharedName = unique('Shared one');
    const privateId = idOf(await create.execute(mod.context, body({ name: 'Private one' })));
    const sharedId = idOf(
      await create.execute(mod.context, body({ name: sharedName, visibility: 'everyone' })),
    );
    const listed = await list.execute(viewer.context, { listKey: LIST });
    const renamed = await update.execute(viewer.context, {
      id: sharedId,
      name: 'Renamed',
      visibility: 'everyone',
    });
    const second = admin([VIEW, SHARE]);
    const renamedByModerator = await update.execute(second.context, {
      id: sharedId,
      name: unique('Renamed'),
      visibility: 'everyone',
    });
    const privateToShared = await update.execute(mod.context, {
      id: privateId,
      name: 'Private one',
      visibility: 'everyone',
    });
    await remove.execute(second.context, { id: sharedId });
    await remove.execute(mod.context, { id: privateId });

    // The Viewer sees the shared one, not the private one, with a real count from the product
    // reader (other tests of this Market may have left shared filters; only these two are judged).
    const items = (
      listed as unknown as { value: { canShare: boolean; items: Record<string, unknown>[] } }
    ).value;
    expect(items.canShare).toBe(false);
    expect(items.items.find((item) => item['id'] === sharedId)).toMatchObject({
      name: sharedName,
      ownedByMe: false,
      canManage: false,
      count: expect.any(Number) as number,
    });
    expect(items.items.some((item) => item['id'] === privateId)).toBe(false);
    expect(failure(renamed)).toBe('access.denied');
    expect(failure(renamedByModerator)).toBe('ok');
    expect(failure(privateToShared)).toBe('ok');
    expect(await rowsOf(market, mod.accountId)).toEqual([]);

    expect((await auditActions(market, sharedId)).map((row) => row.action)).toEqual([
      'catalog.saved-filter.shared',
      'catalog.saved-filter.changed',
      'catalog.saved-filter.removed',
    ]);
    const [shared, changed] = await auditActions(market, sharedId);
    expect(shared).toMatchObject({
      actor_id: mod.accountId,
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
    expect(JSON.stringify(await auditActions(market, sharedId))).not.toContain('Renamed');
    expect(JSON.stringify(await auditActions(market, sharedId))).not.toContain(sharedName);
  });

  it('keeps one name per owner and list whatever its case, one per shared list, and rolls a refused rename back', async () => {
    const a = admin([VIEW, SHARE]);
    const b = admin([VIEW, SHARE]);
    const sharedLamb = unique('Lamb for all');
    await create.execute(a.context, body({ name: 'Lamb' }));

    expect(failure(await create.execute(a.context, body({ name: 'LAMB' })))).toBe(
      'saved-filter.name-taken',
    );
    // Two admins may keep the same private name…
    const bPrivate = idOf(await create.execute(b.context, body({ name: 'lamb' })));
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
    // Nothing changed for b, and a's shared filter is intact.
    expect(await rowsOf(market, b.accountId)).toEqual([
      expect.objectContaining({ id: bPrivate, name: 'lamb', visibility: 'me' }),
    ]);
    expect((await rowsOf(market, a.accountId)).map((row) => row.id)).toContain(aShared);
  });

  it(`stops at ${MAX_SAVED_FILTERS_PER_OWNER} filters per owner and list even when rows were written around the use case`, async () => {
    const a = admin([VIEW]);
    for (let n = 1; n <= MAX_SAVED_FILTERS_PER_OWNER; n++) {
      await owner.query(
        `INSERT INTO catalog.saved_filters
           (id, market_id, tenant_id, owner_account_id, visibility, list_key, name, payload, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'me', $5, $6, $7, $8, $9, $9)`,
        [
          uuid7(),
          market.marketId,
          market.tenantId,
          a.accountId,
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
    // A single delete makes room, and the new filter takes the next position.
    const first = (await rowsOf(market, a.accountId))[0]!;
    await remove.execute(a.context, { id: first.id });
    expect(failure(await create.execute(a.context, body({ name: 'Fits now' })))).toBe('ok');
    expect((await rowsOf(market, a.accountId)).at(-1)).toMatchObject({
      name: 'Fits now',
      position: MAX_SAVED_FILTERS_PER_OWNER + 1,
    });
  });

  it('never reads, lists, renames or deletes another Market’s filters', async () => {
    const here = admin([VIEW, SHARE]);
    const there = admin([VIEW, SHARE], other);
    const canary = unique('Canary');
    const sharedHere = idOf(
      await create.execute(here.context, body({ name: canary, visibility: 'everyone' })),
    );
    await create.execute(there.context, body({ name: canary, visibility: 'everyone' }));

    const listed = await list.execute(there.context, { listKey: LIST });

    const names = (listed as unknown as { value: { items: { name: string }[] } }).value.items.map(
      (item) => item.name,
    );
    expect(names.filter((name) => name === canary)).toHaveLength(1);
    expect(
      failure(
        await update.execute(there.context, { id: sharedHere, name: 'Taken', visibility: 'me' }),
      ),
    ).toBe('saved-filter.not-found');
    expect(failure(await remove.execute(there.context, { id: sharedHere }))).toBe(
      'saved-filter.not-found',
    );
    expect((await rowsOf(market, here.accountId)).map((row) => row.name)).toContain(canary);
  });

  describe('the table as the application role', () => {
    const insertAs = (client: Client, overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        owner_account_id: account(),
        visibility: 'me',
        list_key: LIST,
        name: `Check ${uuid7()}`,
        payload: PAYLOAD,
        position: 1,
        created_at: new Date('2026-10-31T00:00:00Z'),
        updated_at: new Date('2026-10-31T00:00:00Z'),
        ...overrides,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO catalog.saved_filters (${columns.join(', ')})
         VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('takes a valid row', async () => {
      await expect(insertAs(app)).resolves.toMatchObject({ rowCount: 1 });
    });

    it.each([
      ['a name with a leading space', { name: ' lamb' }],
      ['an empty name', { name: '' }],
      ['a name of 61 characters', { name: 'x'.repeat(61) }],
      ['a name with a control character', { name: 'a\u0007b' }],
      ['another visibility', { visibility: 'team' }],
      ['a list key without a dot', { list_key: 'products' }],
      ['a list key in upper case', { list_key: 'Admin.Catalog.Products' }],
      ['a payload that is an array', { payload: JSON.stringify([1]) }],
      ['a payload over 2 KB', { payload: { v: 1, q: 'x'.repeat(2100) } }],
      ['position 0', { position: 0 }],
      ['an update time before the creation time', { updated_at: new Date('2026-10-30T00:00:00Z') }],
      ['a Market code in lower case', { market_id: 'au' }],
    ])('refuses %s (CHECK)', async (_label, overrides) => {
      await expect(insertAs(app, overrides)).rejects.toMatchObject({ code: CHECK });
    });

    it('refuses a name that differs only by case for one owner, but not for two', async () => {
      const ownerAccountId = account();
      await insertAs(app, { owner_account_id: ownerAccountId, name: 'Case' });

      await expect(
        insertAs(app, { owner_account_id: ownerAccountId, name: 'CASE' }),
      ).rejects.toMatchObject({ code: UNIQUE });
      await expect(insertAs(app, { name: 'CASE' })).resolves.toMatchObject({ rowCount: 1 });
    });

    it('lets the role change the name, visibility and update time, and delete, but nothing else', async () => {
      const rowId = uuid7();
      await insertAs(app, { id: rowId, name: 'Grant check' });

      await expect(
        app.query(
          `UPDATE catalog.saved_filters SET name = 'Grant renamed', visibility = 'everyone', updated_at = now() WHERE id = $1`,
          [rowId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const column of [
        'owner_account_id',
        'list_key',
        'payload',
        'position',
        'market_id',
        'created_at',
      ]) {
        const value =
          column === 'owner_account_id'
            ? `'${account()}'`
            : column === 'payload'
              ? `'{}'::jsonb`
              : column === 'position'
                ? '2'
                : column === 'market_id'
                  ? `'ZZ'`
                  : column === 'created_at'
                    ? 'now()'
                    : `'admin.catalog.other'`;
        await expect(
          app.query(`UPDATE catalog.saved_filters SET ${column} = ${value} WHERE id = $1`, [rowId]),
        ).rejects.toMatchObject({ code: DENIED });
      }
      await expect(
        app.query(`DELETE FROM catalog.saved_filters WHERE id = $1`, [rowId]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
