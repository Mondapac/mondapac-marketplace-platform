import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  testMarketId,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerInventory } from '../../domain/seller-inventory';
import { ConfigInventoryPolicyProvider } from '../../infrastructure/config-inventory-policy-provider';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import { CreateSource } from './create-source.use-case';
import { EditSource } from './edit-source.use-case';
import { ListSources } from './list-sources.use-case';
import { ReorderSources } from './reorder-sources.use-case';

// Inventory slice 1, part 2 in memory (inventory design 3.4, 6; UX F29, D12; AC 11), on both Market
// fixtures. The Market's source limit differs between them. The gate admits every authenticated
// actor; the declarations are checked by the CI list. PostgreSQL behaviour (the two-pass
// reorder, the version check, the constraints) is in test/db/inventory-sources.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigInventoryPolicyProvider(markets);

class FakeInventories implements SellerInventoryRepository {
  readonly stored = new Map<string, SellerInventory>();
  saves = 0;
  /** Set to make the next save find another edit in between. */
  staleOnSave = false;

  private key(market: MarketContext, sellerId: string) {
    return `${market.marketId}|${sellerId}`;
  }
  add(market: MarketContext, inventory: SellerInventory): Promise<boolean> {
    this.stored.set(this.key(market, inventory.state.sellerId), inventory);
    return Promise.resolve(true);
  }
  findBySeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerInventory | null> {
    const found = this.stored.get(this.key(market, sellerId));
    return Promise.resolve(found === undefined ? null : SellerInventory.fromStored(found.state));
  }
  save(market: MarketContext, inventory: SellerInventory): Promise<'saved' | 'stale'> {
    const current = this.stored.get(this.key(market, inventory.state.sellerId));
    if (
      this.staleOnSave ||
      current === undefined ||
      current.state.version !== inventory.persistedVersion
    ) {
      this.staleOnSave = false;
      return Promise.resolve('stale');
    }
    this.saves += 1;
    this.stored.set(this.key(market, inventory.state.sellerId), inventory);
    return Promise.resolve('saved');
  }
}

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const inventories = new FakeInventories();
  const units: UnitOfWorkOptions[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      _m: MarketContext,
      work: () => Promise<Result<T, E>>,
      o: UnitOfWorkOptions = {},
    ) => {
      units.push(o);
      return work();
    },
    runOnce: () => Promise.reject(new Error('not used')),
  };
  const deps = { unitOfWork, inventories, policies };
  return {
    clock,
    ids,
    inventories,
    units,
    list: new ListSources(gate, deps),
    create: new CreateSource(gate, { ...deps, ids, clock }),
    edit: new EditSource(gate, deps),
    reorder: new ReorderSources(gate, deps),
  };
}
type T = ReturnType<typeof setUp>;

describe.each(['AU', 'ZZ'] as const)('inventory source use cases in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const max = markets.get(testMarketId(code)).inventory!.maxSourcesPerSeller;
  const logged: unknown[] = [];
  beforeEach(() => {
    logged.length = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logged.push(m);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  function seller(t: T, approved = true) {
    const sellerId = t.ids.next<'Seller'>();
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: t.ids.next<'Account'>(),
        sessionId: t.ids.next<'Session'>(),
        sellerId,
      }),
    );
    if (approved) {
      void t.inventories.add(
        market,
        SellerInventory.createWithDefaultSource({
          id: t.ids.next<'SellerInventory'>(),
          defaultSourceId: t.ids.next<'InventorySource'>(),
          sellerId,
          marketId: market.marketId,
          now: START,
        }),
      );
    }
    return { sellerId, context };
  }
  const body = (name: string) => ({ name, address: null, timeZone: null });
  const view = <V>(result: { ok: true; value: V } | { ok: false; error: unknown }): V => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  it('declares its permissions: view for the list, source.edit for the three writes', () => {
    expect(ListSources.access).toMatchObject({
      name: 'inventory.list-sources',
      rule: { kind: 'permissions', allOf: ['inventory.stock.view'] },
      whenSellerNotApproved: 'deny',
    });
    for (const [type, name] of [
      [CreateSource, 'inventory.create-source'],
      [EditSource, 'inventory.edit-source'],
      [ReorderSources, 'inventory.reorder-sources'],
    ] as const) {
      expect(type.access).toMatchObject({
        name,
        rule: { kind: 'permissions', allOf: ['inventory.source.edit'] },
        whenSellerNotApproved: 'deny',
      });
    }
  });

  it('lists the Default source, the version and the Market limit, in a read-only unit', async () => {
    const t = setUp();
    const s = seller(t);
    const list = view(await t.list.execute(s.context, {}));
    expect(list).toMatchObject({
      version: 1,
      max,
      sources: [{ name: 'Default', isDefault: true, position: 1, address: null, timeZone: null }],
    });
    expect(t.units).toEqual([{ readOnly: true }]);
  });

  it('answers inventory.not-ready everywhere while the approval event has not run', async () => {
    const t = setUp();
    const s = seller(t, false);
    const notReady = { ok: false, error: { code: 'inventory.not-ready' } };
    expect(await t.list.execute(s.context, {})).toEqual(notReady);
    expect(await t.create.execute(s.context, { expectedVersion: 1, ...body('A') })).toEqual(
      notReady,
    );
  });

  it('appends a source last and returns the new version', async () => {
    const t = setUp();
    const s = seller(t);
    const out = view(
      await t.create.execute(s.context, {
        expectedVersion: 1,
        name: ' Garage ',
        address: { line1: '1 Test St' },
        timeZone: 'Australia/Brisbane',
      }),
    );
    expect(out.version).toBe(2);
    expect(out.sources.map((x) => [x.name, x.position])).toEqual([
      ['Default', 1],
      ['Garage', 2],
    ]);
    expect(out.sources[1]).toMatchObject({
      address: { line1: '1 Test St' },
      timeZone: 'Australia/Brisbane',
      isDefault: false,
    });
    expect(t.units).toEqual([{}]);
  });

  it(`refuses the ${max + 1}th source with the limit in details (Market limit ${max})`, async () => {
    const t = setUp();
    const s = seller(t);
    let version = 1;
    for (let i = 1; i < max; i += 1) {
      version = view(
        await t.create.execute(s.context, { expectedVersion: version, ...body(`S${i}`) }),
      ).version;
    }
    const over = await t.create.execute(s.context, { expectedVersion: version, ...body('Over') });
    expect(over).toEqual({
      ok: false,
      error: { code: 'inventory.sources.limit-reached', details: { max } },
    });
    expect(t.inventories.stored.get(`${code}|${s.sellerId}`)!.state.sources).toHaveLength(max);
  });

  it('answers conflict.stale for an old version, before the limit, and saves nothing', async () => {
    const t = setUp();
    const s = seller(t);
    view(await t.create.execute(s.context, { expectedVersion: 1, ...body('A') }));
    const saves = t.inventories.saves;
    for (const result of [
      await t.create.execute(s.context, { expectedVersion: 1, ...body('B') }),
      await t.edit.execute(s.context, {
        expectedVersion: 1,
        sourceId: t.inventories.stored.get(`${code}|${s.sellerId}`)!.state.sources[0]!.id,
        ...body('X'),
      }),
      await t.reorder.execute(s.context, { expectedVersion: 1, orderedSourceIds: [] }),
    ]) {
      expect(result.ok).toBe(false);
    }
    expect(t.inventories.saves).toBe(saves);
  });

  it('answers conflict.stale when the store finds another edit in between', async () => {
    const t = setUp();
    const s = seller(t);
    t.inventories.staleOnSave = true;
    expect(await t.create.execute(s.context, { expectedVersion: 1, ...body('A') })).toEqual({
      ok: false,
      error: { code: 'conflict.stale' },
    });
  });

  it('renames the Default and edits address and zone, keeping its position and badge', async () => {
    const t = setUp();
    const s = seller(t);
    const defaultId = view(await t.list.execute(s.context, {})).sources[0]!.id;
    const out = view(
      await t.edit.execute(s.context, {
        expectedVersion: 1,
        sourceId: defaultId,
        name: 'Main shed',
        address: { line1: '2 Test St' },
        timeZone: 'Australia/Perth',
      }),
    );
    expect(out.version).toBe(2);
    expect(out.sources[0]).toMatchObject({
      id: defaultId,
      name: 'Main shed',
      isDefault: true,
      position: 1,
      timeZone: 'Australia/Perth',
    });
  });

  it('keeps the version when an edit changes nothing', async () => {
    const t = setUp();
    const s = seller(t);
    const defaultId = view(await t.list.execute(s.context, {})).sources[0]!.id;
    const out = view(
      await t.edit.execute(s.context, {
        expectedVersion: 1,
        sourceId: defaultId,
        ...body('Default'),
      }),
    );
    expect(out.version).toBe(1);
    expect(t.inventories.saves).toBe(0);
  });

  it("answers the same not-found for another seller's source as for an unknown id (AC 11)", async () => {
    const t = setUp();
    const mine = seller(t);
    const theirs = seller(t);
    const theirSource = view(await t.list.execute(theirs.context, {})).sources[0]!.id;
    const expected = { ok: false, error: { code: 'inventory.source.not-found' } };
    expect(
      await t.edit.execute(mine.context, {
        expectedVersion: 1,
        sourceId: theirSource,
        ...body('Mine now'),
      }),
    ).toEqual(expected);
    expect(
      await t.edit.execute(mine.context, {
        expectedVersion: 1,
        sourceId: t.ids.next<'InventorySource'>(),
        ...body('Unknown'),
      }),
    ).toEqual(expected);
    expect(view(await t.list.execute(theirs.context, {})).sources[0]!.name).toBe('Default');
  });

  it('reorders by the whole list, and refuses a list that is not exactly the seller sources', async () => {
    const t = setUp();
    const s = seller(t);
    const a = view(await t.create.execute(s.context, { expectedVersion: 1, ...body('A') }));
    if (max < 2) return;
    const [d, x] = a.sources.map((y) => y.id);
    const out = view(
      await t.reorder.execute(s.context, {
        expectedVersion: a.version,
        orderedSourceIds: [x!, d!],
      }),
    );
    expect(out.sources.map((y) => [y.name, y.position])).toEqual([
      ['A', 1],
      ['Default', 2],
    ]);
    const mismatch = { ok: false, error: { code: 'inventory.sources.order-mismatch' } };
    expect(
      await t.reorder.execute(s.context, { expectedVersion: out.version, orderedSourceIds: [d!] }),
    ).toEqual(mismatch);
    expect(
      await t.reorder.execute(s.context, {
        expectedVersion: out.version,
        orderedSourceIds: [d!, d!],
      }),
    ).toEqual(mismatch);
  });

  it('keeps the version when the order is unchanged', async () => {
    const t = setUp();
    const s = seller(t);
    const list = view(await t.list.execute(s.context, {}));
    const out = view(
      await t.reorder.execute(s.context, {
        expectedVersion: list.version,
        orderedSourceIds: list.sources.map((y) => y.id),
      }),
    );
    expect(out.version).toBe(list.version);
  });

  it('refuses bad input with paths and codes only, never the text', async () => {
    const t = setUp();
    const s = seller(t);
    const secret = 'Hidden\u0007Name';
    const result = await t.create.execute(s.context, {
      expectedVersion: 0,
      name: secret,
      address: { Bad: 'x' },
      timeZone: 'Nowhere/Land',
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'expectedVersion', code: 'format' },
          { path: 'name', code: 'characters' },
          { path: 'address', code: 'fields' },
          { path: 'timeZone', code: 'unknown' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('Hidden');
    const reorder = await t.reorder.execute(s.context, {
      expectedVersion: 1,
      orderedSourceIds: ['not-an-id'],
    });
    expect(reorder).toMatchObject({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'orderedSourceIds.0', code: 'format' }],
      },
    });
  });

  it('writes no name, address or zone to any log line', async () => {
    const t = setUp();
    const s = seller(t);
    view(
      await t.create.execute(s.context, {
        expectedVersion: 1,
        name: 'Secret depot',
        address: { line1: '99 Hidden Rd' },
        timeZone: 'Australia/Brisbane',
      }),
    );
    await t.create.execute(s.context, { expectedVersion: 7, ...body('Secret again') });
    const text = JSON.stringify(logged);
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('Hidden');
    expect(text).not.toContain('Brisbane');
    expect(logged.length).toBeGreaterThan(0);
  });

  it.each(['customer', 'admin'] as const)(
    'refuses a %s even when the gate admits it',
    async (population) => {
      const t = setUp();
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: t.ids.next<'Account'>(),
          sessionId: t.ids.next<'Session'>(),
          sellerId: null,
        }),
      );
      const denied = { ok: false, error: { code: 'access.denied' } };
      expect(await t.list.execute(context, {})).toEqual(denied);
      expect(await t.create.execute(context, { expectedVersion: 1, ...body('A') })).toEqual(denied);
      expect(
        await t.edit.execute(context, {
          expectedVersion: 1,
          sourceId: t.ids.next<'InventorySource'>(),
          ...body('A'),
        }),
      ).toEqual(denied);
      expect(
        await t.reorder.execute(context, { expectedVersion: 1, orderedSourceIds: [] }),
      ).toEqual(denied);
    },
  );
});
