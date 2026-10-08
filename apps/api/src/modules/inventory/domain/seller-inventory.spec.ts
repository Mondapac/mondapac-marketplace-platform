import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { DEFAULT_SOURCE_NAME, SellerInventory } from './seller-inventory';

// The aggregate of inventory slice 1 (inventory design 2.1, 3.4; data design 3.2, 3.3).

const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
const ids = new SequenceIdGenerator(clock);

function created() {
  const market = testMarketContext('AU', 'default');
  return SellerInventory.createWithDefaultSource({
    id: ids.next<'SellerInventory'>(),
    defaultSourceId: ids.next<'InventorySource'>(),
    sellerId: ids.next<'Seller'>(),
    marketId: market.marketId,
    now: clock.now(),
  });
}

describe('SellerInventory.createWithDefaultSource', () => {
  it('starts at version 1 with no threshold override', () => {
    const { state } = created();

    expect(state.version).toBe(1);
    expect(state.lowStockThreshold).toBeNull();
    expect(state.createdAt.epochMilliseconds).toBe(clock.now().epochMilliseconds);
  });

  it('holds exactly one source: the Default, at priority 1, named by the stored default', () => {
    const { state } = created();

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0]).toMatchObject({
      isDefault: true,
      priority: 1,
      name: DEFAULT_SOURCE_NAME,
    });
  });

  it('keeps the source name inside the database limits (1 to 80, no outer spaces)', () => {
    expect(DEFAULT_SOURCE_NAME.length).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_SOURCE_NAME.length).toBeLessThanOrEqual(80);
    expect(DEFAULT_SOURCE_NAME).toBe(DEFAULT_SOURCE_NAME.trim());
  });

  it('is immutable from outside', () => {
    const { state } = created();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.sources)).toBe(true);
    expect(Object.isFrozen(state.sources[0])).toBe(true);
  });
});
