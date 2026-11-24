import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import type { PayoutHoldRecord } from '../../src/modules/commission-payouts/application/ports/payout-hold.repository';
import type { DisputeCase } from '../../src/modules/commission-payouts/domain/dispute';
import { moveTo, openPayout } from '../../src/modules/commission-payouts/domain/payout';
import { PrismaDisputeRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-dispute.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaPayoutRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout.repository';
import { PrismaCommissionPayoutsWorkQueueCountReader } from '../../src/modules/commission-payouts/infrastructure/prisma-work-queue-count.reader';
import type { AccountSnapshot } from '../../src/modules/payments/domain/connected-account';
import type { AccountStatus } from '../../src/modules/payments/domain/connected-account';
import type { EventOutcome } from '../../src/modules/payments/application/ports/stripe-event-inbox';
import { PrismaConnectedAccountStore } from '../../src/modules/payments/infrastructure/prisma-connected-account-store';
import { PrismaStripeEventInbox } from '../../src/modules/payments/infrastructure/prisma-stripe-event-inbox';
import { PrismaPaymentsWorkQueueCountReader } from '../../src/modules/payments/infrastructure/prisma-work-queue-count.reader';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import type { WorkQueueCount } from '../../src/platform/work-queue/work-queue-count';
import { TEST_MARKETS } from '../support/test-config';
import { dashboardPaymentsQueueTestDatabaseUrl } from './test-database';
import { createPersistence, marketOf, randomUUID, type Persistence } from './persistence-support';

// The payments and commission-payouts counts of the dashboard's work queue (dashboards upgrade,
// phase 1) on PostgreSQL, as the application role, for both Market fixtures, seeded through each
// module's own stores: failed webhooks, restricted connected accounts, failed payouts, active
// payout holds and disputes due, each with a row just inside and just outside every boundary.
// The readers filter on the Market only and other files write the same tables at the same time
// (with 2026 dates), so every row here lives in late 1999 or January 2000 and every limit is set
// there: a count bounded on both sides is exact; a count with no upper bound on time (the failed
// windows, the accounts and holds, which count every row) is at least the rows seeded here, while
// its overdue count and its oldest instant, both below a January 2000 limit, are exact.

const NOW = Temporal.Instant.from('2000-01-10T00:00:00Z');
const WEEK_AGO = NOW.subtract({ hours: 168 });
const MS = { milliseconds: 1 } as const;
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;
const MINIMUM = { AU: 5000n, ZZ: 3000n } as const;
let sequence = 0;
const nextEventId = () => `evt_queue_${process.pid}_${(sequence += 1)}_${Date.now()}`;
const nextRef = () => `acct_queue_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('dashboard payments queue counts in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(NOW));
  let db: Persistence;
  let inbox: PrismaStripeEventInbox;
  let accounts: PrismaConnectedAccountStore;
  let payouts: PrismaPayoutRepository;
  let holds: PrismaPayoutHoldRepository;
  let disputes: PrismaDisputeRepository;
  let payments: PrismaPaymentsWorkQueueCountReader;
  let commission: PrismaCommissionPayoutsWorkQueueCountReader;

  beforeAll(() => {
    db = createPersistence({ databaseUrl: dashboardPaymentsQueueTestDatabaseUrl() });
    inbox = new PrismaStripeEventInbox(db.service);
    accounts = new PrismaConnectedAccountStore(db.service);
    payouts = new PrismaPayoutRepository(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
    disputes = new PrismaDisputeRepository(db.service);
    payments = new PrismaPaymentsWorkQueueCountReader(db.service);
    commission = new PrismaCommissionPayoutsWorkQueueCountReader(db.service);
  });
  afterAll(() => db.close());

  const write = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async (work: () => Promise<WorkQueueCount>): Promise<WorkQueueCount> => {
    const result = await db.unitOfWork.run(market, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('read failed');
    return result.value;
  };

  it('counts the webhooks stuck past the age limit and those given up within the week', async () => {
    const stale = NOW.subtract({ hours: 1 });
    /** One event received at `at`; finished with `outcome` a minute later, or left unapplied. */
    const event = async (at: Temporal.Instant, outcome: EventOutcome | null) => {
      const eventId = nextEventId();
      await write(market, async () => {
        await inbox.record(market, {
          eventId,
          type: 'checkout.session.completed',
          objectId: 'cs_queue_0001',
          receivedAt: at,
        });
        if (outcome === null) {
          await inbox.retryLater(market, eventId, 1, at.add({ minutes: 5 }));
        } else {
          await inbox.finish(market, eventId, outcome, at.add({ minutes: 1 }));
        }
      });
    };
    const oldestStuck = Temporal.Instant.from('1999-12-20T00:00:00Z');
    await event(oldestStuck, null); // stuck for weeks: counted, overdue, the oldest
    await event(stale.subtract(MS), null); // stuck just past the limit: counted, overdue
    await event(stale, null); // retrying for exactly an hour: not yet stuck
    await event(NOW.subtract({ minutes: 10 }), null); // retrying for minutes: not counted
    await event(WEEK_AGO, 'failed'); // given up at the window's start: counted, overdue
    await event(WEEK_AGO.subtract(MS), 'failed'); // given up just before the window: not counted
    await event(NOW.subtract({ minutes: 30 }), 'failed'); // given up recently: counted, not overdue
    await event(NOW.subtract({ hours: 2 }), 'rejected'); // rejected: never counted
    await event(Temporal.Instant.from('1999-12-01T00:00:00Z'), 'confirmed'); // applied: not counted

    const counted = await read(() => payments.failedWebhooks(market, NOW, stale));
    expect(counted.overdue).toBe(3);
    expect(counted.oldestAt).toEqual(oldestStuck);
    expect(counted.count).toBeGreaterThanOrEqual(4);

    // An age limit before every unapplied row: only the given-up ones, the window's start the
    // oldest (the one just before it is left out), none overdue.
    const failedOnly = await read(() =>
      payments.failedWebhooks(market, NOW, Temporal.Instant.from('1999-06-01T00:00:00Z')),
    );
    expect(failedOnly.overdue).toBe(0);
    expect(failedOnly.oldestAt).toEqual(WEEK_AGO);
    expect(failedOnly.count).toBeGreaterThanOrEqual(2);
  });

  it('counts the restricted connected accounts, overdue since their last update', async () => {
    const stale = Temporal.Instant.from('2000-01-09T00:00:00Z');
    const snapshot = (id: string): AccountSnapshot => ({
      id,
      metadataMarketId: code,
      metadataSellerId: null,
      detailsSubmitted: true,
      transfersActive: false,
      payoutsEnabled: false,
      requirementsDue: 1,
      requirementsPastDue: true,
      disabledReason: null,
      payoutScheduleInterval: 'daily',
      externalAccountCount: 1,
      defaultExternalAccountId: null,
    });
    /** One seller's account, last read (and so updated) at `at` in `status`. */
    const account = async (status: AccountStatus, at: Temporal.Instant) => {
      const sellerId = randomUUID();
      const ref = nextRef();
      await write(market, async () => {
        await accounts.insert(market, sellerId, at.subtract({ hours: 1 }));
        await accounts.linkRef(market, sellerId, ref, at.subtract({ minutes: 30 }));
        expect(await accounts.applyRead(market, sellerId, snapshot(ref), status, at)).toBe(true);
      });
    };
    const oldest = Temporal.Instant.from('1999-12-01T00:00:00Z');
    await account('restricted', oldest); // overdue, the oldest
    await account('restricted', stale.subtract(MS)); // overdue
    await account('restricted', stale); // counted, not overdue
    await account('enabled', Temporal.Instant.from('1999-11-01T00:00:00Z')); // not counted

    const counted = await read(() => payments.restrictedAccounts(market, NOW, stale));
    expect(counted.overdue).toBe(2);
    expect(counted.oldestAt).toEqual(oldest);
    expect(counted.count).toBeGreaterThanOrEqual(3);
  });

  it('counts the payouts failed within the week, overdue past the age limit', async () => {
    const stale = NOW.subtract({ hours: 24 });
    /** One payout opened a day before `at`, sent, and ended in `end` at `at`. */
    const payout = async (end: 'failed' | 'paid', at: Temporal.Instant) => {
      const opened = at.subtract({ hours: 24 });
      const items = [{ sellerOrderId: ids.next<'SellerOrder'>(), amount: 10000n }];
      const open = openPayout({
        id: ids.next<'Payout'>(),
        sellerId: ids.next<'Seller'>(),
        currency: CURRENCY[code],
        items,
        netted: 0n,
        approvalMode: 'AUTO',
        firstPayout: false,
        minimum: MINIMUM[code],
        slotAt: opened,
        now: opened,
      });
      const sent = moveTo(open, 'instructed', opened.add({ minutes: 1 }), {
        transferExecutionId: randomUUID(),
      });
      const ended = moveTo(
        sent,
        end,
        at,
        end === 'failed' ? { outcomeCode: 'transfer-failed' } : {},
      );
      await write(market, async () => {
        await payouts.insert(market, open, items);
        expect(await payouts.change(market, open, sent)).toBe(true);
        expect(await payouts.change(market, sent, ended)).toBe(true);
      });
    };
    await payout('failed', WEEK_AGO); // at the window's start: counted, overdue, the oldest
    await payout('failed', WEEK_AGO.subtract(MS)); // older than a week: not counted
    await payout('failed', stale.subtract(MS)); // overdue
    await payout('failed', stale); // counted, not overdue
    await payout('paid', NOW.subtract({ hours: 2 })); // paid: not counted

    const counted = await read(() => commission.failedPayouts(market, NOW, stale));
    expect(counted.overdue).toBe(2);
    expect(counted.oldestAt).toEqual(WEEK_AGO);
    expect(counted.count).toBeGreaterThanOrEqual(3);
  });

  it('counts the active payout holds, overdue since they were placed', async () => {
    const stale = Temporal.Instant.from('2000-01-09T00:00:00Z');
    /** One admin-review hold of its own seller, placed at `at`. */
    const hold = (at: Temporal.Instant): PayoutHoldRecord => {
      const holdId = ids.next<'PayoutHold'>();
      return {
        id: holdId,
        sellerId: ids.next<'Seller'>(),
        sellerOrderId: null,
        reason: 'admin-review',
        origin: 'admin',
        sourceRef: holdId,
        placedBy: ids.next<'Account'>(),
        placedAt: at,
        releasedAt: null,
        releasedBy: null,
        releaseReason: null,
      };
    };
    const oldest = Temporal.Instant.from('1999-12-01T00:00:00Z');
    const released = hold(Temporal.Instant.from('1999-11-01T00:00:00Z'));
    await write(market, async () => {
      for (const at of [oldest, stale.subtract(MS), stale]) {
        expect(await holds.insertIfAbsent(market, hold(at))).toBe(true);
      }
      // Released: never counted, though it is the oldest placed.
      expect(await holds.insertIfAbsent(market, released)).toBe(true);
      expect(
        await holds.release(market, released.id, {
          releasedAt: released.placedAt.add({ hours: 24 }),
          releasedBy: ids.next<'Account'>(),
          reason: 'resolved',
        }),
      ).toBe(true);
    });

    const counted = await read(() => commission.payoutHolds(market, NOW, stale));
    expect(counted.overdue).toBe(2);
    expect(counted.oldestAt).toEqual(oldest);
    expect(counted.count).toBeGreaterThanOrEqual(3);
  });

  it('counts the disputes needing a response within a day, overdue once their deadline passed', async () => {
    /** One case of its own order, opened in December 1999. */
    const dispute = async (
      evidenceDueBy: Temporal.Instant | null,
      bucket: 'needs-response' | 'under-review' = 'needs-response',
    ) => {
      const at = Temporal.Instant.from('1999-12-15T00:00:00Z');
      const c: DisputeCase = {
        disputeId: randomUUID() as Id<'Dispute'>,
        orderId: randomUUID() as Id<'Order'>,
        providerDisputeId: 'dp_queue',
        amount: money(2000n, CURRENCY[code]),
        status: bucket === 'needs-response' ? 'needs_response' : 'under_review',
        inquiry: false,
        closed: false,
        outcome: null,
        reason: 'fraudulent',
        evidenceDueBy,
        fundsWithdrawn: false,
        fundsWithdrawnAt: null,
        fundsReinstated: false,
        fundsReinstatedAt: null,
        openedAt: at,
        closedAt: null,
        bucket,
        lastSyncedVersion: 1,
        createdAt: at,
        updatedAt: at,
      };
      expect(await write(market, () => disputes.insert(market, c))).toBe(true);
    };
    const dayAhead = NOW.add({ hours: 24 });
    const oldest = NOW.subtract({ hours: 48 });
    await dispute(oldest); // past due: counted, overdue, the nearest deadline
    await dispute(NOW.subtract(MS)); // just past due: overdue
    await dispute(NOW); // due now: counted, not overdue
    await dispute(dayAhead.subtract(MS)); // due within the day: counted
    await dispute(dayAhead); // due exactly a day ahead: not counted
    await dispute(NOW.subtract({ hours: 72 }), 'under-review'); // another bucket: not counted
    await dispute(null); // no deadline: not counted

    // Bounded on both sides here (no other file has a case due before 2000-01-11): exact.
    expect(await read(() => commission.disputesDue(market, NOW))).toEqual({
      count: 4,
      overdue: 2,
      oldestAt: oldest,
    });
  });
});
