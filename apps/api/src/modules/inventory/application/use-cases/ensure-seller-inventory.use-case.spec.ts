import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { DEFAULT_SOURCE_NAME, type SellerInventory } from '../../domain/seller-inventory';
import type { SellerInventoryRepository } from '../ports/seller-inventory.repository';
import { EnsureSellerInventory } from './ensure-seller-inventory.use-case';

// Inventory slice 1 in memory (inventory design 3.4, 6; AC 10): the approval handler. Both Market
// fixtures. PostgreSQL behaviour is covered by test/db/inventory-sources.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

class FakeInventories implements SellerInventoryRepository {
  readonly stored = new Map<string, SellerInventory>();
  failing = false;

  add(market: MarketContext, inventory: SellerInventory): Promise<boolean> {
    if (this.failing) return Promise.reject(new Error('boom'));
    const key = `${market.marketId}|${inventory.state.sellerId}`;
    if (this.stored.has(key)) return Promise.resolve(false);
    this.stored.set(key, inventory);
    return Promise.resolve(true);
  }
}

function setUp() {
  const inventories = new FakeInventories();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const unitOfWork: UnitOfWork = {
    run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    runOnce: fakeRunOnce(),
  };
  const ensure = new EnsureSellerInventory(gate, { unitOfWork, inventories, ids, clock });
  return { inventories, ids, ensure };
}

type Setup = ReturnType<typeof setUp>;
const market = (code: string): MarketContext => testMarketContext(code, 'default');
const system = (code: string) => testCallContext(market(code), 'system');
const delivery = (t: Setup): EventDelivery => ({
  eventId: t.ids.next<'event'>(),
  subscriber: 'inventory.ensure-seller-inventory',
  attempt: 1,
});
const input = (t: Setup, sellerId: Id<'Seller'>, accessState = 'approved') => ({
  delivery: delivery(t),
  sellerId,
  accessState,
});

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(['AU', 'ZZ'])('inventory.ensure-seller-inventory in market %s', (code) => {
  it('creates the inventory with its Default source for an approved seller', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();

    const result = await t.ensure.execute(system(code), input(t, sellerId));

    expect(result).toEqual({ ok: true, value: { code: 'seller-inventory.created' } });
    const stored = [...t.inventories.stored.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toMatchObject({
      sellerId,
      marketId: code,
      version: 1,
      sources: [{ isDefault: true, priority: 1, name: DEFAULT_SOURCE_NAME }],
    });
  });

  it('does nothing for a seller that is not approved yet, and records no handled event', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();

    for (const state of ['pending', 'rejected', 'suspended']) {
      const result = await t.ensure.execute(system(code), input(t, sellerId, state));
      expect(result).toEqual({ ok: true, value: { code: 'seller-inventory.not-approved' } });
    }
    expect(t.inventories.stored.size).toBe(0);
  });

  it('is idempotent by the inbox: a redelivery of the same event does nothing', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const same = input(t, sellerId);

    const first = await t.ensure.execute(system(code), same);
    const again = await t.ensure.execute(system(code), same);

    expect(first.ok && first.value.code).toBe('seller-inventory.created');
    expect(again).toEqual({ ok: true, value: { code: 'seller-inventory.already-handled' } });
    expect(t.inventories.stored.size).toBe(1);
  });

  it('is idempotent by the unique key: a second approval, as another event, finds it (AC 10)', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();

    await t.ensure.execute(system(code), input(t, sellerId));
    const second = await t.ensure.execute(system(code), input(t, sellerId));

    expect(second).toEqual({ ok: true, value: { code: 'seller-inventory.exists' } });
    expect(t.inventories.stored.size).toBe(1);
  });

  it('keeps one inventory per seller and a separate one per Market', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const other = code === 'AU' ? 'ZZ' : 'AU';

    await t.ensure.execute(system(code), input(t, sellerId));
    const elsewhere = await t.ensure.execute(system(other), input(t, sellerId));

    expect(elsewhere).toEqual({ ok: true, value: { code: 'seller-inventory.created' } });
    expect(t.inventories.stored.size).toBe(2);
  });

  it('throws when the store fails, so the delivery is retried and nothing is recorded as handled', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const same = input(t, sellerId);
    t.inventories.failing = true;

    await expect(t.ensure.execute(system(code), same)).rejects.toThrow();

    t.inventories.failing = false;
    const retried = await t.ensure.execute(system(code), same);
    expect(retried.ok && retried.value.code).toBe('seller-inventory.created');
  });

  it.each(['anonymous', 'seller'] as const)('refuses a %s caller', async (kind) => {
    const t = setUp();
    const m = market(code);
    const context =
      kind === 'anonymous'
        ? testCallContext(m, 'anonymous')
        : testCallContext(
            m,
            testAuthenticatedActor(m, {
              population: 'seller',
              accountId: t.ids.next<'Account'>(),
              sessionId: t.ids.next<'Session'>(),
              sellerId: t.ids.next<'Seller'>(),
            }),
          );

    const result = await t.ensure.execute(context, input(t, t.ids.next<'Seller'>()));

    expect(result.ok).toBe(false);
    expect(t.inventories.stored.size).toBe(0);
  });
});
