import { parseId, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { AdminSavedFilterCreate } from '../../src/modules/ordering/application/use-cases/admin-saved-filter-create.use-case';
import { AdminSavedFilterDelete } from '../../src/modules/ordering/application/use-cases/admin-saved-filter-delete.use-case';
import { AdminSavedFilterUpdate } from '../../src/modules/ordering/application/use-cases/admin-saved-filter-update.use-case';
import { AdminSavedFiltersList } from '../../src/modules/ordering/application/use-cases/admin-saved-filters-list.use-case';
import { SavedFilterShareCheck } from '../../src/modules/ordering/application/use-cases/saved-filter-share-check.use-case';
import { SellerSavedFilterCreate } from '../../src/modules/ordering/application/use-cases/seller-saved-filter-create.use-case';
import { MAX_SAVED_FILTERS_PER_OWNER } from '../../src/modules/ordering/domain/saved-view';
import { ORDERING_AUDIT_ACTIONS } from '../../src/modules/ordering/domain/audit';
import { PrismaSavedFilterRepository } from '../../src/modules/ordering/infrastructure/prisma-saved-filter.repository';
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

// The order-list saved filters on PostgreSQL as the application role, in both Market fixtures
// (ordering data design 3.15): the real use cases on the real unit of work and the real audit
// writer create, list, rename, share and delete filters; the table's CHECKs and the two
// case-insensitive name uniques hold; the cap holds against rows written around the use case; the
// role can change a filter's name and visibility only; and no Market reads another's.

const T0 = Temporal.Instant.from('2026-11-06T00:00:00Z');
const CHECK = '23514';
const UNIQUE = '23505';
const DENIED = '42501';
const ADMIN_LIST = 'admin.ordering.orders';
const SELLER_LIST = 'seller.ordering.orders';
const VIEW = 'ordering.order.view';
const SELLER_VIEW = 'ordering.seller-order.view';
const SHARE = 'ordering.saved-filter.share';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const PAYLOAD = {
  v: 1,
  tab: 'confirmed',
  filters: { paymentState: 'captured' },
  sort: 'total-high',
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

describe.each(TEST_MARKETS)('order list saved filters in market %s (database)', (code) => {
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
  let create: AdminSavedFilterCreate;
  let update: AdminSavedFilterUpdate;
  let remove: AdminSavedFilterDelete;
  let list: AdminSavedFiltersList;
  let sellerCreate: SellerSavedFilterCreate;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    app = new Client({ connectionString: testDatabaseUrl() });
    await Promise.all([owner.connect(), app.connect()]);
    // The real audit writer: the audit row commits with the change, as in production.
    const catalogue = new AuditActionCatalogue();
    catalogue.register('ordering', ORDERING_AUDIT_ACTIONS);
    catalogue.seal();
    audit = PersistenceModule.auditWriterFor('ordering').useFactory(
      catalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    const savedFilters = new PrismaSavedFilterRepository(db.service);
    const base = { unitOfWork: db.unitOfWork, savedFilters, audit, clock, ids };
    const adminDeps = { ...base, shareCheck: new SavedFilterShareCheck(gate) };
    create = new AdminSavedFilterCreate(gate, adminDeps);
    update = new AdminSavedFilterUpdate(gate, adminDeps);
    remove = new AdminSavedFilterDelete(gate, adminDeps);
    list = new AdminSavedFiltersList(gate, adminDeps);
    sellerCreate = new SellerSavedFilterCreate(gate, { ...base, shareCheck: null });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), db.close()]);
    await db.close().catch(() => undefined);
  });

  const person = (
    population: 'admin' | 'seller',
    keys: readonly string[],
    target: MarketContext = market,
  ) => {
    const accountId = account();
    held.set(accountId, keys);
    const context: CallContext = testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId,
        sessionId: uuid7() as Id<'Session'>,
        sellerId: population === 'seller' ? (uuid7() as Id<'Seller'>) : null,
      }),
      'ordering-saved-filters-db-abcd',
    );
    return { accountId, context };
  };
  const admin = (keys: readonly string[], target: MarketContext = market) =>
    person('admin', keys, target);
  const body = (overrides: Record<string, unknown> = {}) => ({
    listKey: ADMIN_LIST,
    name: 'Captured, big',
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
        `SELECT id, name, visibility, position FROM ordering.saved_filters
          WHERE market_id = $1 AND owner_account_id = $2 ORDER BY position`,
        [target.marketId, ownerAccountId],
      )
    ).rows;
  const auditActions = async (target: MarketContext, targetId: string) =>
    (
      await owner.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, id`,
        [target.marketId, targetId],
      )
    ).rows;
  const failure = (result: { ok: boolean; error?: { code: string } }) =>
    result.ok ? 'ok' : result.error?.code;

  it('creates, lists, renames, shares and deletes, with audit rows only for shared filters', async () => {
    const mod = admin([VIEW, SHARE]);
    const viewer = admin([VIEW]);
    const sharedName = unique('Shared one');
    const privateId = idOf(await create.execute(mod.context, body({ name: 'Private one' })));
    const sharedId = idOf(
      await create.execute(mod.context, body({ name: sharedName, visibility: 'everyone' })),
    );

    const listed = await list.execute(viewer.context, { listKey: ADMIN_LIST });
    const renamedByViewer = await update.execute(viewer.context, {
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
    await remove.execute(second.context, { id: sharedId });
    await remove.execute(mod.context, { id: privateId });

    const answer = (listed as unknown as { value: { canShare: boolean; items: { id: string }[] } })
      .value;
    expect(answer.canShare).toBe(false);
    expect(answer.items.some((item) => item.id === sharedId)).toBe(true);
    expect(answer.items.some((item) => item.id === privateId)).toBe(false);
    expect(failure(renamedByViewer)).toBe('access.denied');
    expect(failure(renamedByModerator)).toBe('ok');
    expect(await rowsOf(market, mod.accountId)).toEqual([]);
    expect((await auditActions(market, sharedId)).map((row) => row.action)).toEqual([
      'ordering.saved-filter.shared',
      'ordering.saved-filter.changed',
      'ordering.saved-filter.removed',
    ]);
    // A private filter is never audited.
    expect(await auditActions(market, privateId)).toEqual([]);
    expect(JSON.stringify(await auditActions(market, sharedId))).not.toContain(sharedName);
  });

  it('keeps one name per owner and list whatever its case, and one per shared list', async () => {
    const a = admin([VIEW, SHARE]);
    const b = admin([VIEW, SHARE]);
    const sharedName = unique('Paid for all');
    await create.execute(a.context, body({ name: 'Paid' }));

    expect(failure(await create.execute(a.context, body({ name: 'PAID' })))).toBe(
      'saved-filter.name-taken',
    );
    const bPrivate = idOf(await create.execute(b.context, body({ name: 'paid' })));
    await create.execute(a.context, body({ name: sharedName, visibility: 'everyone' }));
    expect(
      failure(
        await create.execute(
          b.context,
          body({ name: sharedName.toUpperCase(), visibility: 'everyone' }),
        ),
      ),
    ).toBe('saved-filter.name-taken');
    expect(
      failure(
        await update.execute(b.context, { id: bPrivate, name: sharedName, visibility: 'everyone' }),
      ),
    ).toBe('saved-filter.name-taken');
    expect(await rowsOf(market, b.accountId)).toEqual([
      expect.objectContaining({ id: bPrivate, name: 'paid', visibility: 'me' }),
    ]);
  });

  it('keeps a seller’s filters personal: no sharing, and the admin list is not theirs', async () => {
    const seller = person('seller', [SELLER_VIEW]);
    const filterId = idOf(
      await sellerCreate.execute(seller.context, {
        listKey: SELLER_LIST,
        name: 'To ship',
        payload: { v: 1, tab: 'to-ship' },
      }),
    );

    expect(
      failure(
        await sellerCreate.execute(seller.context, {
          listKey: SELLER_LIST,
          name: 'Everyone',
          visibility: 'everyone',
          payload: { v: 1, tab: 'to-ship' },
        }),
      ),
    ).toBe('validation.failed');
    expect(
      failure(
        await sellerCreate.execute(seller.context, {
          listKey: ADMIN_LIST,
          name: 'Wrong list',
          payload: PAYLOAD,
        }),
      ),
    ).toBe('validation.failed');
    expect(await rowsOf(market, seller.accountId)).toEqual([
      expect.objectContaining({ id: filterId, visibility: 'me' }),
    ]);
    expect(await auditActions(market, filterId)).toEqual([]);
  });

  it(`stops at ${MAX_SAVED_FILTERS_PER_OWNER} filters per owner and list even when rows were written around the use case`, async () => {
    const a = admin([VIEW]);
    for (let n = 1; n <= MAX_SAVED_FILTERS_PER_OWNER; n++) {
      await owner.query(
        `INSERT INTO ordering.saved_filters
           (id, market_id, tenant_id, owner_account_id, visibility, list_key, name, payload, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'me', $5, $6, $7, $8, $9, $9)`,
        [
          uuid7(),
          market.marketId,
          market.tenantId,
          a.accountId,
          ADMIN_LIST,
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
    const first = (await rowsOf(market, a.accountId))[0]!;
    await remove.execute(a.context, { id: first.id });
    expect(failure(await create.execute(a.context, body({ name: 'Fits now' })))).toBe('ok');
  });

  it('never reads, renames or deletes another Market’s filters', async () => {
    const here = admin([VIEW, SHARE]);
    const there = admin([VIEW, SHARE], other);
    const canary = unique('Canary');
    const sharedHere = idOf(
      await create.execute(here.context, body({ name: canary, visibility: 'everyone' })),
    );
    await create.execute(there.context, body({ name: canary, visibility: 'everyone' }));

    const listed = await list.execute(there.context, { listKey: ADMIN_LIST });

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
  });

  describe('the table as the application role', () => {
    const insertAs = (client: Client, overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        id: uuid7(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        owner_account_id: account(),
        visibility: 'me',
        list_key: ADMIN_LIST,
        name: `Check ${uuid7()}`,
        payload: PAYLOAD,
        position: 1,
        created_at: new Date('2026-11-06T00:00:00Z'),
        updated_at: new Date('2026-11-06T00:00:00Z'),
        ...overrides,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO ordering.saved_filters (${columns.join(', ')})
         VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('takes a valid row', async () => {
      await expect(insertAs(app)).resolves.toMatchObject({ rowCount: 1 });
    });

    it.each([
      ['a name with a leading space', { name: ' paid' }],
      ['an empty name', { name: '' }],
      ['a name of 61 characters', { name: 'x'.repeat(61) }],
      ['a name with a control character', { name: 'a\u0007b' }],
      ['another visibility', { visibility: 'team' }],
      ['a list key without a dot', { list_key: 'orders' }],
      ['a list key in upper case', { list_key: 'Admin.Ordering.Orders' }],
      ['a payload that is an array', { payload: JSON.stringify([1]) }],
      ['a payload over 2 KB', { payload: { v: 1, q: 'x'.repeat(2100) } }],
      ['position 0', { position: 0 }],
      ['an update time before the creation time', { updated_at: new Date('2026-11-05T00:00:00Z') }],
      ['a Market code in lower case', { market_id: 'au' }],
      [
        'a filter shared with everyone on a seller list',
        { list_key: SELLER_LIST, visibility: 'everyone' },
      ],
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
          `UPDATE ordering.saved_filters SET name = 'Grant renamed', visibility = 'everyone', updated_at = now() WHERE id = $1`,
          [rowId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      const forbidden: Record<string, string> = {
        owner_account_id: `'${account()}'`,
        list_key: `'admin.ordering.other'`,
        payload: `'{}'::jsonb`,
        position: '2',
        market_id: `'ZZ'`,
        created_at: 'now()',
      };
      for (const [column, value] of Object.entries(forbidden)) {
        await expect(
          app.query(`UPDATE ordering.saved_filters SET ${column} = ${value} WHERE id = $1`, [
            rowId,
          ]),
        ).rejects.toMatchObject({ code: DENIED });
      }
      await expect(
        app.query(`DELETE FROM ordering.saved_filters WHERE id = $1`, [rowId]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });
});
