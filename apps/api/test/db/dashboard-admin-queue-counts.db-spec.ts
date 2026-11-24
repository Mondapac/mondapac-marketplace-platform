import { ok, Temporal } from '@mondapac/shared-kernel';
import { PrismaCatalogWorkQueueCountReader } from '../../src/modules/catalog/infrastructure/prisma-work-queue-count.reader';
import { PrismaCommissionPayoutsWorkQueueCountReader } from '../../src/modules/commission-payouts/infrastructure/prisma-work-queue-count.reader';
import { PrismaCertificationWorkQueueCountReader } from '../../src/modules/certification/infrastructure/prisma-work-queue-count.reader';
import { PrismaPaymentsWorkQueueCountReader } from '../../src/modules/payments/infrastructure/prisma-work-queue-count.reader';
import { PrismaPricingWorkQueueCountReader } from '../../src/modules/pricing/infrastructure/prisma-work-queue-count.reader';
import { PrismaSecurityWorkQueueCountReader } from '../../src/modules/security/infrastructure/prisma-work-queue-count.reader';
import { PrismaSellerHealthStore } from '../../src/modules/sellers/infrastructure/prisma-seller-health.store';
import { PrismaSellersWorkQueueCountReader } from '../../src/modules/sellers/infrastructure/prisma-work-queue-count.reader';
import {
  isWorkQueueCount,
  type WorkQueueCount,
} from '../../src/platform/work-queue/work-queue-count';
import { PrismaLiveListingCounter } from '../../src/modules/search/infrastructure/prisma-live-listing-counter';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';

// The catalog, pricing, sellers, security, certification, payments and commission-payouts counts of the dashboard's work queue (dashboards upgrade,
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
  let claims: (now: Temporal.Instant) => Promise<WorkQueueCount>;
  let disputes: (now: Temporal.Instant) => Promise<WorkQueueCount>;
  let readers: Record<string, (staleBefore: Temporal.Instant) => Promise<WorkQueueCount>>;
  let expiring: (now: Temporal.Instant, until: Temporal.Instant) => Promise<number>;
  let opened: (from: Temporal.Instant, to: Temporal.Instant) => Promise<number>;
  let listings: () => Promise<{ active: number; outOfStock: number }>;

  beforeAll(() => {
    db = createPersistence();
    const catalog = new PrismaCatalogWorkQueueCountReader(db.service);
    const pricing = new PrismaPricingWorkQueueCountReader(db.service);
    const security = new PrismaSecurityWorkQueueCountReader(db.service);
    const certification = new PrismaCertificationWorkQueueCountReader(db.service);
    const payments = new PrismaPaymentsWorkQueueCountReader(db.service);
    const payouts = new PrismaCommissionPayoutsWorkQueueCountReader(db.service);
    const sellers = new PrismaSellersWorkQueueCountReader(
      db.service,
      new PrismaSellerHealthStore(db.service),
    );
    claims = (now) => catalog.claimsWithoutCertificate(market, now);
    disputes = (now) => payouts.disputesDue(market, now);
    expiring = (now, until) => certification.expiringSellerCertificates(market, now, until);
    opened = (from, to) => payouts.disputesOpened(market, from, to);
    const search = new PrismaLiveListingCounter(db.service);
    listings = () => search.liveListings(market);
    readers = {
      'security.openAlerts': (stale) => security.openAlerts(market, NOW, stale),
      'certification.sellerCertificates': (stale) =>
        certification.sellerCertificates(market, NOW, stale),
      'certification.productCertificates': (stale) =>
        certification.productCertificates(market, NOW, stale),
      'catalog.pendingOffers': (stale) => catalog.pendingOffers(market, NOW, stale),
      'catalog.pendingRevisions': (stale) => catalog.pendingRevisions(market, NOW, stale),
      'catalog.brandMerges': (stale) => catalog.brandMerges(market, NOW, stale),
      'catalog.categoryProposals': (stale) => catalog.categoryProposals(market, NOW, stale),
      'pricing.priceHolds': (stale) => pricing.priceHolds(market, NOW, stale),
      'sellers.applications': (stale) => sellers.applications(market, NOW, stale),
      'sellers.unhealthySellers': () => sellers.unhealthySellers(market, NOW),
      'payments.failedWebhooks': (stale) => payments.failedWebhooks(market, NOW, stale),
      'payments.restrictedAccounts': (stale) => payments.restrictedAccounts(market, NOW, stale),
      'commissionPayouts.failedPayouts': (stale) => payouts.failedPayouts(market, NOW, stale),
      'commissionPayouts.payoutHolds': (stale) => payouts.payoutHolds(market, NOW, stale),
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
    'security.openAlerts',
    'certification.sellerCertificates',
    'certification.productCertificates',
    'catalog.pendingOffers',
    'catalog.pendingRevisions',
    'catalog.brandMerges',
    'catalog.categoryProposals',
    'pricing.priceHolds',
    'sellers.applications',
    'sellers.unhealthySellers',
    'payments.failedWebhooks',
    'payments.restrictedAccounts',
    'commissionPayouts.failedPayouts',
    'commissionPayouts.payoutHolds',
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

  it('counts the badges past their certificate as incidents: every one overdue', async () => {
    const counted = await read(() => claims(NOW));
    expect(isWorkQueueCount(counted)).toBe(true);
    expect(counted.overdue).toBe(counted.count);
    expect(counted.oldestAt === null).toBe(counted.count === 0);
    // No certificate ended before 1990: nothing is counted at that moment.
    expect(await read(() => claims(BEFORE_ANY))).toEqual({ count: 0, overdue: 0, oldestAt: null });
  });

  it('counts the disputes due within a day, overdue once their deadline passed', async () => {
    const counted = await read(() => disputes(NOW));
    expect(isWorkQueueCount(counted)).toBe(true);
    expect(counted.oldestAt === null).toBe(counted.count === 0);
    // No dispute was due before 1990: nothing is counted at that moment.
    expect(await read(() => disputes(BEFORE_ANY))).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });

  // The supply and health numbers of the KPI answer (dashboards v2, PR 6): each statement runs on
  // the real schema and grants as the application role and answers a whole count; an empty window
  // before any row counts nothing.
  it('counts the certificates expiring, the chargebacks opened and the live listings', async () => {
    const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
    expect(whole(await read(() => expiring(NOW, NOW.add({ hours: 31 * 24 }))))).toBe(true);
    expect(await read(() => expiring(BEFORE_ANY, BEFORE_ANY.add({ hours: 1 })))).toBe(0);
    expect(whole(await read(() => opened(BEFORE_ANY, AFTER_ALL)))).toBe(true);
    expect(await read(() => opened(BEFORE_ANY, BEFORE_ANY.add({ hours: 1 })))).toBe(0);
    const live = await read(listings);
    // Two counts side by side with no transaction: other files' writes may land between them,
    // so only their shape is checked.
    expect(whole(live.active) && whole(live.outOfStock)).toBe(true);
  });
});
