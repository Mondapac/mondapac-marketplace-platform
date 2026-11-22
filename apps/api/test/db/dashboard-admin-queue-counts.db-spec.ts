import { ok, Temporal } from '@mondapac/shared-kernel';
import { PrismaCatalogWorkQueueCountReader } from '../../src/modules/catalog/infrastructure/prisma-work-queue-count.reader';
import { PrismaPricingWorkQueueCountReader } from '../../src/modules/pricing/infrastructure/prisma-work-queue-count.reader';
import { PrismaSellerHealthStore } from '../../src/modules/sellers/infrastructure/prisma-seller-health.store';
import { PrismaSellersWorkQueueCountReader } from '../../src/modules/sellers/infrastructure/prisma-work-queue-count.reader';
import {
  isWorkQueueCount,
  type WorkQueueCount,
} from '../../src/platform/work-queue/work-queue-count';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// The catalog, pricing and sellers counts of the dashboard's work queue (dashboards upgrade,
// phase 1) on PostgreSQL, as the application role, for both Market fixtures. Each count reuses
// the where clause of its queue's own list (covered by that list's database spec); here every
// statement runs against the real schema and grants, and its answer holds together: a valid
// count, none overdue at an age limit before any row, all overdue at one after every row.

const NOW = Temporal.Instant.from('2026-11-22T01:00:00Z');
const BEFORE_ANY = Temporal.Instant.from('1990-01-01T00:00:00Z');
const AFTER_ALL = Temporal.Instant.from('2100-01-01T00:00:00Z');

describe.each(TEST_MARKETS)('dashboard admin queue counts in market %s (database)', (code) => {
  const market = marketOf(code);
  let db: Persistence;
  let readers: Record<string, (staleBefore: Temporal.Instant) => Promise<WorkQueueCount>>;

  beforeAll(() => {
    db = createPersistence();
    const catalog = new PrismaCatalogWorkQueueCountReader(db.service);
    const pricing = new PrismaPricingWorkQueueCountReader(db.service);
    const sellers = new PrismaSellersWorkQueueCountReader(
      db.service,
      new PrismaSellerHealthStore(db.service),
    );
    readers = {
      'catalog.pendingOffers': (stale) => catalog.pendingOffers(market, NOW, stale),
      'catalog.pendingRevisions': (stale) => catalog.pendingRevisions(market, NOW, stale),
      'catalog.brandMerges': (stale) => catalog.brandMerges(market, NOW, stale),
      'catalog.categoryProposals': (stale) => catalog.categoryProposals(market, NOW, stale),
      'pricing.priceHolds': (stale) => pricing.priceHolds(market, NOW, stale),
      'sellers.applications': (stale) => sellers.applications(market, NOW, stale),
      'sellers.unhealthySellers': (stale) => sellers.unhealthySellers(market, NOW, stale),
    };
  });
  afterAll(() => db.close());

  const read = async <T>(work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(market, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('read failed');
    return result.value;
  };

  it.each([
    'catalog.pendingOffers',
    'catalog.pendingRevisions',
    'catalog.brandMerges',
    'catalog.categoryProposals',
    'pricing.priceHolds',
    'sellers.applications',
    'sellers.unhealthySellers',
  ])('%s answers a count that holds together', async (name) => {
    const early = await read(() => readers[name]!(BEFORE_ANY));
    expect(isWorkQueueCount(early)).toBe(true);
    expect(early.overdue).toBe(0);
    if (name === 'sellers.unhealthySellers') {
      // A snapshot, not a wait: never overdue, no oldest.
      expect(early.oldestAt).toBeNull();
      return;
    }
    expect(early.oldestAt === null).toBe(early.count === 0);
    const late = await read(() => readers[name]!(AFTER_ALL));
    // Other files write rows at the same time: at least the rows counted early are overdue late.
    expect(late.overdue).toBe(late.count);
    expect(late.count).toBeGreaterThanOrEqual(0);
  });
});
