import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import type { DisputeCase } from '../../src/modules/commission-payouts/domain/dispute';
import { PrismaDisputeRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-dispute.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaCommissionPayoutsWorkQueueCountReader } from '../../src/modules/commission-payouts/infrastructure/prisma-work-queue-count.reader';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { PrismaWorkQueueCountReader } from '../../src/modules/ordering/infrastructure/prisma-work-queue-count.reader';
import type {
  AccountSnapshot,
  AccountStatus,
} from '../../src/modules/payments/domain/connected-account';
import { PrismaConnectedAccountStore } from '../../src/modules/payments/infrastructure/prisma-connected-account-store';
import { PrismaPaymentsWorkQueueCountReader } from '../../src/modules/payments/infrastructure/prisma-work-queue-count.reader';
import { PrismaReviewsWorkQueueCountReader } from '../../src/modules/reviews/infrastructure/prisma-work-queue-count.reader';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import type { WorkQueueCount } from '../../src/platform/work-queue/work-queue-count';
import { TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, randomUUID, type Persistence } from './persistence-support';

// The seller tasks of the dashboard (dashboards upgrade, phase 1, PR 6) on PostgreSQL, as the
// application role, for both Market fixtures, seeded through each module's own stores (reviews
// directly): late orders, orders to get ready today, ready pickups not collected, blocked payouts,
// disputes needing a reply, active holds and unanswered reviews. Every test uses a fresh seller id
// and seeds another seller's row beside it (never counted), and every time is in late 1999 or
// January 2000, so each count is exact.

const NOW = Temporal.Instant.from('2000-01-10T00:00:00Z');
const STALE = NOW.subtract({ hours: 48 });
const MS = { milliseconds: 1 } as const;
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;
let sequence = 0;
const nextRef = () => `acct_tasks_${process.pid}_${(sequence += 1)}_${Date.now()}`;
const date = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);

describe.each(TEST_MARKETS)('dashboard seller tasks in market %s (database)', (code) => {
  const market = marketOf(code);
  const ids = new UuidV7IdGenerator(new FixedClock(NOW));
  const live = new AbortController().signal;
  let db: Persistence;
  let orders: PrismaOrderRepository;
  let accounts: PrismaConnectedAccountStore;
  let holds: PrismaPayoutHoldRepository;
  let disputes: PrismaDisputeRepository;
  let ordering: PrismaWorkQueueCountReader;
  let payments: PrismaPaymentsWorkQueueCountReader;
  let commission: PrismaCommissionPayoutsWorkQueueCountReader;
  let reviews: PrismaReviewsWorkQueueCountReader;

  beforeAll(() => {
    db = createPersistence();
    orders = new PrismaOrderRepository(db.service);
    accounts = new PrismaConnectedAccountStore(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
    disputes = new PrismaDisputeRepository(db.service);
    ordering = new PrismaWorkQueueCountReader(db.service);
    payments = new PrismaPaymentsWorkQueueCountReader(db.service);
    commission = new PrismaCommissionPayoutsWorkQueueCountReader(db.service);
    reviews = new PrismaReviewsWorkQueueCountReader(db.service);
  });
  afterAll(() => db.close());

  const write = async <T>(work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(market, async () => ok(await work()));
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

  interface Placed {
    readonly method?: 'instant' | 'same_day' | 'pickup' | 'scheduled';
    readonly window?: { readonly start: Temporal.Instant; readonly end: Temporal.Instant };
    readonly prep?: number | null;
    /** Written after placement, as the fulfilment units would. */
    readonly later?: Record<string, unknown>;
  }

  /** One paid seller order of `sellerId`, paid at `paidAt`. */
  const sellerOrder = async (sellerId: Id<'Seller'>, paidAt: Temporal.Instant, placed: Placed) => {
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    const currency = CURRENCY[code];
    const order: OrderState = {
      id: orderId,
      marketId: market.marketId,
      accountId: ids.next<'Account'>(),
      status: 'confirmed',
      cancelReason: null,
      paymentState: 'captured',
      total: money(1000n, currency),
      reservationId: ids.next<'Reservation'>(),
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: `cs_${orderId.replaceAll('-', '')}`,
      stripePaymentIntentId: `pi_${orderId.replaceAll('-', '')}`,
      paymentExpiresAt: paidAt.add({ minutes: 30 }),
      createdAt: paidAt,
      confirmedAt: paidAt,
      cancelledAt: null,
      version: 1,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: [
        {
          id: sellerOrderId,
          sellerId,
          subtotal: 1000n,
          shipping: 0n,
          discount: 0n,
          shippingDiscount: 0n,
          shippingTaxRateBps: null,
          shippingTax: null,
          shippingTaxInclusive: null,
          total: 1000n,
          fulfilment: 'to-ship',
          carrier: null,
          trackingRef: null,
          shippedAt: null,
          deliveredAt: null,
          inventoryRecordedAt: null,
          ledgerState: 'not-applicable',
          deliveryMethod: placed.method ?? 'instant',
          deliveryWindow: placed.window ?? null,
          readyAt: null,
          readyPrepMinutes: placed.prep === undefined ? 30 : placed.prep,
          deliveryAttention: null,
          buyerFirst: null,
          deliveryQuote: null,
        },
      ],
      lines: [
        {
          id: ids.next<'OrderLine'>(),
          sellerOrderId,
          offerId: ids.next<'Offer'>(),
          variantId: ids.next<'Variant'>(),
          quantity: 1,
          unitPrice: money(1000n, currency),
          lineAmount: 1000n,
          discountAmount: 0n,
          discountSellerShare: 0n,
          discountPlatformShare: 0n,
          taxInclusive: true,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
          commissionRateReason: 'standard',
          exclusiveSeller: false,
          taxRateBps: null,
          taxAmount: null,
          taxCategoryCode: null,
        },
      ],
    };
    await write(async () => {
      await orders.insert(market, order);
      if (placed.later !== undefined) {
        await db.service.tx(market).orderingSellerOrder.updateMany({
          where: { marketId: market.marketId, id: sellerOrderId },
          data: placed.later,
        });
      }
    });
  };

  it("counts the seller's late orders by the admin rule, never another seller's", async () => {
    const seller = ids.next<'Seller'>();
    const paid = NOW.subtract({ hours: 6 });
    await sellerOrder(seller, paid, { prep: 30 }); // ready-by 5h30 ago: late, overdue, the oldest
    await sellerOrder(seller, NOW.subtract({ minutes: 45 }), { prep: 30 }); // 15 min late
    await sellerOrder(seller, NOW.subtract({ minutes: 30 }), { prep: 30 }); // due now: not late
    await sellerOrder(seller, paid, {
      method: 'scheduled',
      window: { start: NOW.subtract({ hours: 3 }), end: NOW.subtract({ hours: 2 }) },
      later: {
        fulfilment: 'shipped',
        carrier: 'Courier',
        shippedAt: date(NOW.subtract({ hours: 4 })),
      },
    }); // scheduled, shipped, not delivered by its window end: late, not overdue
    await sellerOrder(ids.next<'Seller'>(), paid, { prep: 30 }); // another seller: never counted

    expect(
      await read(() =>
        ordering.sellerLateOrders(market, seller, NOW, NOW.subtract({ hours: 3 }), live),
      ),
    ).toEqual({ count: 3, overdue: 1, oldestAt: paid.add({ minutes: 30 }) });
  });

  it("counts the orders to get ready on the seller's day, none late, none ready", async () => {
    const seller = ids.next<'Seller'>();
    const dayStart = NOW.subtract({ hours: 10 });
    const dayEnd = NOW.add({ hours: 14 });
    const first = NOW.subtract({ hours: 2 });
    await sellerOrder(seller, first, { prep: 180 }); // ready-by in 1 hour: counted, the oldest
    await sellerOrder(seller, NOW.subtract({ minutes: 30 }), { method: 'pickup', prep: 30 }); // due now
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), {
      method: 'scheduled',
      window: { start: NOW.add({ hours: 4 }), end: NOW.add({ hours: 6 }) },
    }); // window later today: counted
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), {
      method: 'scheduled',
      window: { start: dayStart.subtract(MS), end: NOW.add({ hours: 1 }) },
    }); // window started yesterday: not today's
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), {
      method: 'scheduled',
      window: { start: dayEnd, end: dayEnd.add({ hours: 2 }) },
    }); // window tomorrow: not counted
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), { prep: 2880 }); // due tomorrow
    await sellerOrder(seller, NOW.subtract({ hours: 2 }), { prep: 30 }); // late: the late queue's
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), {
      prep: 180,
      later: { readyAt: date(NOW.subtract({ minutes: 5 })) },
    }); // marked ready: done
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), { prep: null }); // no promise
    await sellerOrder(ids.next<'Seller'>(), first, { prep: 180 }); // another seller
    // The edges of the day: a window starting exactly at the day start is today's; a ready-by
    // exactly at the day end is tomorrow's, one a millisecond before it is today's (the oldest).
    await sellerOrder(seller, NOW.subtract({ hours: 1 }), {
      method: 'scheduled',
      window: { start: dayStart, end: NOW.add({ hours: 1 }) },
    }); // counted
    await sellerOrder(seller, dayEnd.subtract({ hours: 48 }), { prep: 2880 }); // not counted
    const edge = dayEnd.subtract({ hours: 48 }).subtract(MS);
    await sellerOrder(seller, edge, { prep: 2880 }); // counted, paid first

    expect(
      await read(() => ordering.sellerToShipToday(market, seller, NOW, dayStart, dayEnd, live)),
    ).toEqual({ count: 5, overdue: 0, oldestAt: edge });
  });

  it('counts the ready pickups not collected, overdue by their ready time', async () => {
    const seller = ids.next<'Seller'>();
    const paid = NOW.subtract({ hours: 100 });
    const oldest = STALE.subtract({ hours: 20 });
    const pickup = (readyAt: Temporal.Instant | null, later: Record<string, unknown> = {}) =>
      sellerOrder(seller, paid, {
        method: 'pickup',
        later: { ...(readyAt === null ? {} : { readyAt: date(readyAt) }), ...later },
      });
    await pickup(oldest); // overdue, the oldest
    await pickup(STALE.subtract(MS)); // overdue
    await pickup(STALE); // counted, not overdue
    await pickup(null); // not ready yet: not counted
    await pickup(STALE, {
      fulfilment: 'delivered',
      shippedAt: date(NOW),
      deliveredAt: date(NOW),
    }); // collected: not counted
    await sellerOrder(seller, paid, { later: { readyAt: date(oldest) } }); // not a pickup
    await sellerOrder(ids.next<'Seller'>(), paid, {
      method: 'pickup',
      later: { readyAt: date(oldest) },
    }); // another seller

    expect(await read(() => ordering.sellerPickupsUncollected(market, seller, STALE))).toEqual({
      count: 3,
      overdue: 2,
      oldestAt: oldest,
    });
  });

  it("answers 1 for the seller's restricted or not-paying account, 0 otherwise", async () => {
    const snapshot = (ref: string, payoutsEnabled: boolean): AccountSnapshot => ({
      id: ref,
      metadataMarketId: code,
      metadataSellerId: null,
      detailsSubmitted: true,
      transfersActive: payoutsEnabled,
      payoutsEnabled,
      requirementsDue: payoutsEnabled ? 0 : 1,
      requirementsPastDue: false,
      disabledReason: null,
      payoutScheduleInterval: 'daily',
      externalAccountCount: 1,
      defaultExternalAccountId: null,
    });
    const account = async (status: AccountStatus | null, payoutsEnabled: boolean) => {
      const sellerId = randomUUID() as Id<'Seller'>;
      const at = Temporal.Instant.from('1999-12-01T00:00:00Z');
      await write(async () => {
        await accounts.insert(market, sellerId, at.subtract({ hours: 1 }));
        if (status === null) return;
        const ref = nextRef();
        await accounts.linkRef(market, sellerId, ref, at.subtract({ minutes: 30 }));
        expect(
          await accounts.applyRead(market, sellerId, snapshot(ref, payoutsEnabled), status, at),
        ).toBe(true);
      });
      return { sellerId, at };
    };
    const restricted = await account('restricted', true);
    expect(await read(() => payments.sellerPayoutsBlocked(market, restricted.sellerId))).toEqual({
      count: 1,
      overdue: 0,
      oldestAt: restricted.at,
    });
    const pending = await account('pending', false);
    expect((await read(() => payments.sellerPayoutsBlocked(market, pending.sellerId))).count).toBe(
      1,
    );
    const notStarted = await account(null, false);
    expect(
      (await read(() => payments.sellerPayoutsBlocked(market, notStarted.sellerId))).count,
    ).toBe(1);
    const enabled = await account('enabled', true);
    expect(await read(() => payments.sellerPayoutsBlocked(market, enabled.sellerId))).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
    const none = randomUUID() as Id<'Seller'>;
    expect((await read(() => payments.sellerPayoutsBlocked(market, none))).count).toBe(0);
  });

  it("counts the disputes of the seller's orders that need a reply, and the active holds", async () => {
    const seller = ids.next<'Seller'>();
    const other = ids.next<'Seller'>();
    const opened = Temporal.Instant.from('1999-12-15T00:00:00Z');
    /** One dispute case, held on one seller order of `sellerId` (two for `twoOrders`). */
    const dispute = async (
      sellerId: Id<'Seller'>,
      evidenceDueBy: Temporal.Instant | null,
      bucket: 'needs-response' | 'under-review' = 'needs-response',
      twoOrders = false,
    ) => {
      const disputeId = randomUUID() as Id<'Dispute'>;
      const c: DisputeCase = {
        disputeId,
        orderId: randomUUID() as Id<'Order'>,
        providerDisputeId: 'dp_tasks',
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
        openedAt: opened,
        closedAt: null,
        bucket,
        lastSyncedVersion: 1,
        createdAt: opened,
        updatedAt: opened,
      };
      await write(async () => {
        expect(await disputes.insert(market, c)).toBe(true);
        for (let n = 0; n < (twoOrders ? 2 : 1); n += 1) {
          expect(
            await holds.insertIfAbsent(market, {
              id: ids.next<'PayoutHold'>(),
              sellerId,
              sellerOrderId: ids.next<'SellerOrder'>(),
              reason: 'dispute',
              origin: 'system',
              sourceRef: disputeId,
              placedBy: null,
              placedAt: opened,
              releasedAt: null,
              releasedBy: null,
              releaseReason: null,
            }),
          ).toBe(true);
        }
      });
    };
    const nearest = NOW.subtract({ hours: 30 });
    await dispute(seller, nearest, 'needs-response', true); // overdue, the nearest; two holds
    await dispute(seller, NOW.subtract(MS)); // just past: overdue
    await dispute(seller, NOW); // due now: counted, not overdue
    await dispute(seller, null); // no deadline: counted, none overdue
    await dispute(seller, NOW.subtract({ hours: 40 }), 'under-review'); // another bucket
    await dispute(other, NOW.subtract({ hours: 50 })); // another seller

    expect(await read(() => commission.sellerDisputesNeedingReply(market, seller, NOW))).toEqual({
      count: 4,
      overdue: 2,
      oldestAt: nearest,
    });
    // The holds of those disputes are the seller's active holds too (6 of them, all old).
    expect(await read(() => commission.sellerPayoutHolds(market, seller, STALE))).toEqual({
      count: 6,
      overdue: 6,
      oldestAt: opened,
    });
    const fresh = ids.next<'Seller'>();
    expect(await read(() => commission.sellerDisputesNeedingReply(market, fresh, NOW))).toEqual({
      count: 0,
      overdue: 0,
      oldestAt: null,
    });
  });

  it("counts the seller's published reviews without the shop's published reply", async () => {
    const seller = ids.next<'Seller'>();
    const tx = () => db.service.tx(market);
    /** One review of `sellerId`, published at `at`, with a reply in `reply` (or none). */
    const review = async (
      sellerId: Id<'Seller'>,
      at: Temporal.Instant,
      status: 'published' | 'held' = 'published',
      reply: 'published' | 'hidden' | null = null,
    ) => {
      const reviewId = ids.next<'ProductReview'>();
      await write(async () => {
        await tx().reviewsProductReview.create({
          data: {
            id: reviewId,
            marketId: market.marketId,
            tenantId: market.tenantId,
            accountId: null,
            productId: ids.next<'Product'>(),
            offerId: ids.next<'Offer'>(),
            sellerId,
            rating: 4,
            locale: 'en',
            anonymous: false,
            status,
            createdAt: date(at),
            publishedAt: status === 'published' ? date(at) : null,
            lastPurchaseAt: date(at),
          },
        });
        if (reply !== null) {
          await tx().reviewsReply.create({
            data: {
              id: ids.next<'Reply'>(),
              marketId: market.marketId,
              tenantId: market.tenantId,
              reviewId,
              sellerId,
              body: 'Thank you',
              status: reply,
              createdAt: date(at.add({ hours: 1 })),
            },
          });
        }
      });
    };
    const stale = NOW.subtract({ hours: 7 * 24 });
    const oldest = stale.subtract({ hours: 24 });
    await review(seller, oldest); // overdue, the oldest
    await review(seller, stale.subtract(MS)); // overdue
    await review(seller, stale); // counted, not overdue
    await review(seller, NOW.subtract({ hours: 1 }), 'published', 'hidden'); // hidden reply
    await review(seller, oldest.subtract({ hours: 1 }), 'published', 'published'); // answered
    await review(seller, oldest.subtract({ hours: 2 }), 'held'); // not published
    await review(ids.next<'Seller'>(), oldest.subtract({ hours: 3 })); // another seller

    expect(await read(() => reviews.sellerUnanswered(market, seller, stale))).toEqual({
      count: 4,
      overdue: 2,
      oldestAt: oldest,
    });
  });
});
