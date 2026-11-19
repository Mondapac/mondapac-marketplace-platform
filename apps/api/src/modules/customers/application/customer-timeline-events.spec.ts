import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CustomerListRow } from '../domain/customer-list';
import { customerConsentTimelineSubscriptions } from '../presentation/subscribers/customer-consent-timeline.subscriptions';
import { customerReviewTimelineSubscriptions } from '../presentation/subscribers/customer-review-timeline.subscriptions';
import { customerTimelineSubscriptions } from '../presentation/subscribers/customer-timeline.subscriptions';
import type { DirectoryRecordPeer } from './ports/customer-read-model-peers';
import { InMemoryCustomerList } from './testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from './testing/in-memory-customer-management';
import {
  RecordCustomerTimeline,
  type TimelineRecordDependencies,
} from './use-cases/record-customer-timeline.use-case';

// The customer timeline fed by events (phase 2a), on both Market fixtures: order and refund events
// find their customer through ordering, account events name it; an account without a directory
// row yet is written once identity confirms it; a repeated delivery or event writes one row; a peer
// that cannot answer refuses (the delivery is retried); the subscriptions skip other populations.
// Phase 2b, part 3: reviews' events find their author through reviews (as the system), and a
// review that is gone or whose author was deleted writes nothing. Part 4: legal's consent event
// names the account and the channel; the entry keeps the channel as its detail, never a value.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const NEWBIE = id<'Account'>(0xa2);
const ORDER = id<'Order'>(0x0d1);
const REFUND = id<'Refund'>(0x0f1);
const REVIEW = id<'ProductReview'>(0x0b1);
const DETACHED_REVIEW = id<'ProductReview'>(0x0b2);
const delivery = (n: number, subscriber = 'customers.timeline-test'): EventDelivery => ({
  eventId: id<'event'>(0xe00 + n),
  subscriber,
  attempt: 1,
});

describe.each(TEST_MARKET_IDS)('customer timeline from events in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'timeline-system-abcd');
  let list: InMemoryCustomerList;
  let timeline: InMemoryCustomerTimeline;
  let identityKnows: Set<string>;
  let identityDown: boolean;
  let orderingDown: boolean;
  let reviewsDown: boolean;
  let authorAsked: CallContext[];
  let record: RecordCustomerTimeline;

  const row = (accountId: Id<'Account'>): CustomerListRow => ({
    accountId,
    email: 'a@example.test',
    groups: [],
    displayName: null,
    status: 'active',
    emailVerified: true,
    signedUpAt: T0,
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
  });

  beforeEach(() => {
    list = new InMemoryCustomerList();
    timeline = new InMemoryCustomerTimeline(list);
    list.add(market, row(ALICE));
    identityKnows = new Set([ALICE, NEWBIE]);
    identityDown = false;
    orderingDown = false;
    reviewsDown = false;
    authorAsked = [];
    const clock = new FixedClock(T0);
    const deps: TimelineRecordDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      timeline,
      ids: new SequenceIdGenerator(clock),
      clock,
      identity: {
        customerDirectoryRecords: (_c: CallContext, ids: readonly Id<'Account'>[]) =>
          Promise.resolve(
            identityDown
              ? err({ code: 'identity.unavailable' })
              : ok(
                  ids
                    .filter((a) => identityKnows.has(a))
                    .map((accountId): DirectoryRecordPeer => ({
                      accountId,
                      email: 'n@example.test',
                      displayName: null,
                      status: 'active',
                      emailVerifiedAt: null,
                      signedUpAt: T0,
                    })),
                ),
          ),
        customerDirectoryPage: () => Promise.resolve(ok([])),
      },
      reviews: {
        reviewAuthorOf: (context: CallContext, reviewId: string) => {
          authorAsked.push(context);
          if (reviewsDown) return Promise.resolve(err({ code: 'access.unavailable' }));
          if (reviewId === 'nope') return Promise.resolve(err({ code: 'validation.failed' }));
          return Promise.resolve(ok({ accountId: reviewId === REVIEW ? ALICE : null }));
        },
      },
      ordering: {
        customerOrderStats: () => Promise.resolve(err({ code: 'unused' })),
        customerOrderAccounts: () => Promise.resolve(ok({ accountIds: [] })),
        orderNotice: (_c: CallContext, orderId: string) =>
          Promise.resolve(
            orderingDown
              ? err({ code: 'ordering.unavailable' })
              : orderId === ORDER
                ? ok({ accountId: ALICE })
                : err({ code: 'ordering.order-not-found' }),
          ),
        refundNotice: (
          _c: CallContext,
          r: { readonly orderId: string; readonly refundId: string },
        ) =>
          Promise.resolve(
            orderingDown
              ? err({ code: 'ordering.unavailable' })
              : r.orderId === ORDER
                ? ok({ accountId: ALICE, amount: { amount: 100n, currency: 'AUD' } })
                : err({ code: 'ordering.refund-not-found' }),
          ),
      },
    };
    record = new RecordCustomerTimeline(gate, deps);
  });

  const entriesOf = (accountId: Id<'Account'>) =>
    timeline.entries.get(`${market.marketId}:${accountId}`) ?? [];

  it('copies an order paid and a refund onto the paying customer, with the reference', async () => {
    const paid = await record.execute(system, {
      kind: 'order-paid',
      orderId: ORDER,
      eventId: id(0x101),
      occurredAt: T0,
      delivery: delivery(1),
    });
    expect(paid).toEqual(ok({ recorded: true }));
    await record.execute(system, {
      kind: 'refund-succeeded',
      orderId: ORDER,
      refundId: REFUND,
      eventId: id(0x102),
      occurredAt: T0,
      delivery: delivery(2),
    });
    expect(entriesOf(ALICE).map((e) => [e.kind, e.ref])).toEqual([
      ['order-paid', { type: 'order', id: ORDER }],
      ['refund-succeeded', { type: 'refund', id: REFUND }],
    ]);
  });

  it('writes nothing for an order that is gone, and an account identity does not know', async () => {
    const gone = await record.execute(system, {
      kind: 'order-paid',
      orderId: id(0x0d9),
      eventId: id(0x103),
      occurredAt: T0,
      delivery: delivery(3),
    });
    expect(gone).toEqual(ok({ recorded: false }));
    const stranger = id<'Account'>(0xaf);
    const unknown = await record.execute(system, {
      kind: 'signed-up',
      accountId: stranger,
      eventId: id(0x104),
      occurredAt: T0,
      delivery: delivery(4),
    });
    expect(unknown).toEqual(ok({ recorded: false }));
    expect(entriesOf(stranger)).toEqual([]);
  });

  it('retries a sign-up that comes before the directory row, and writes it once the row is there', async () => {
    const input = {
      kind: 'signed-up' as const,
      accountId: NEWBIE,
      eventId: id(0x105),
      occurredAt: T0,
      delivery: delivery(5),
    };
    expect(await record.execute(system, input)).toEqual(err({ code: 'customers.unavailable' }));
    expect(entriesOf(NEWBIE)).toEqual([]);
    list.add(market, row(NEWBIE));
    expect(await record.execute(system, input)).toEqual(ok({ recorded: true }));
    expect(entriesOf(NEWBIE).map((e) => e.kind)).toEqual(['signed-up']);
  });

  it('writes one row for a repeated delivery and for the same event on a new delivery', async () => {
    const input = {
      kind: 'email-verified' as const,
      accountId: ALICE,
      eventId: id(0x106),
      occurredAt: T0,
    };
    await record.execute(system, { ...input, delivery: delivery(6) });
    await record.execute(system, { ...input, delivery: delivery(6) });
    await record.execute(system, { ...input, delivery: delivery(7) });
    expect(entriesOf(ALICE)).toHaveLength(1);
  });

  it('refuses malformed ids, and a peer that cannot answer, so the delivery is retried', async () => {
    const bad = await record.execute(system, {
      kind: 'signed-up',
      accountId: 'nope',
      eventId: id(0x107),
      occurredAt: T0,
      delivery: delivery(8),
    });
    expect(bad).toEqual(err({ code: 'validation.failed' }));
    const badEvent = await record.execute(system, {
      kind: 'signed-up',
      accountId: ALICE,
      eventId: 'nope',
      occurredAt: T0,
      delivery: delivery(9),
    });
    expect(badEvent).toEqual(err({ code: 'validation.failed' }));
    identityDown = true;
    const down = await record.execute(system, {
      kind: 'signed-up',
      accountId: NEWBIE,
      eventId: id(0x108),
      occurredAt: T0,
      delivery: delivery(10),
    });
    expect(down).toEqual(err({ code: 'customers.unavailable' }));
    orderingDown = true;
    const orderDown = await record.execute(system, {
      kind: 'order-paid',
      orderId: ORDER,
      eventId: id(0x109),
      occurredAt: T0,
      delivery: delivery(11),
    });
    expect(orderDown).toEqual(err({ code: 'customers.unavailable' }));
  });

  it('copies a review event onto its author, found through reviews as the system', async () => {
    for (const [n, kind] of [
      [1, 'review-held'],
      [2, 'review-published'],
      [3, 'review-hidden'],
      [4, 'review-restored'],
    ] as const) {
      const result = await record.execute(system, {
        kind,
        reviewId: REVIEW,
        eventId: id(0x110 + n),
        occurredAt: T0.add({ minutes: n }),
        delivery: delivery(30 + n),
      });
      expect(result).toEqual(ok({ recorded: true }));
    }
    expect(entriesOf(ALICE).map((e) => [e.kind, e.ref, e.actorAccountId])).toEqual([
      ['review-held', null, null],
      ['review-published', null, null],
      ['review-hidden', null, null],
      ['review-restored', null, null],
    ]);
    expect(authorAsked.every((context) => context.actor.kind === 'system')).toBe(true);
  });

  it('writes nothing for a review that is gone or detached, and retries when reviews cannot answer', async () => {
    const detached = await record.execute(system, {
      kind: 'review-published',
      reviewId: DETACHED_REVIEW,
      eventId: id(0x121),
      occurredAt: T0,
      delivery: delivery(41),
    });
    expect(detached).toEqual(ok({ recorded: false }));
    const bad = await record.execute(system, {
      kind: 'review-published',
      reviewId: 'nope',
      eventId: id(0x122),
      occurredAt: T0,
      delivery: delivery(42),
    });
    expect(bad).toEqual(err({ code: 'validation.failed' }));
    reviewsDown = true;
    const down = await record.execute(system, {
      kind: 'review-hidden',
      reviewId: REVIEW,
      eventId: id(0x123),
      occurredAt: T0,
      delivery: delivery(43),
    });
    expect(down).toEqual(err({ code: 'customers.unavailable' }));
    expect(entriesOf(ALICE)).toEqual([]);
    reviewsDown = false;
    const again = await record.execute(system, {
      kind: 'review-hidden',
      reviewId: REVIEW,
      eventId: id(0x123),
      occurredAt: T0,
      delivery: delivery(44),
    });
    expect(again).toEqual(ok({ recorded: true }));
    await record.execute(system, {
      kind: 'review-hidden',
      reviewId: REVIEW,
      eventId: id(0x123),
      occurredAt: T0,
      delivery: delivery(45),
    });
    expect(entriesOf(ALICE)).toHaveLength(1);
  });

  describe('subscriptions', () => {
    const find = (name: string) => {
      const found = customerTimelineSubscriptions(record).find((s) => s.name === name);
      if (found === undefined) throw new Error(`no subscription ${name}`);
      return found as unknown as {
        handle: (
          consumed: {
            eventId: string;
            occurredAt: Temporal.Instant;
            payload: Record<string, unknown>;
          },
          delivery: EventDelivery,
          context: CallContext,
        ) => Promise<void>;
      };
    };
    const consumed = (n: number, payload: Record<string, unknown>) => ({
      eventId: id(0x200 + n),
      occurredAt: T0,
      payload,
    });

    it('skips a seller’s or an admin’s account event and records a customer’s', async () => {
      const verified = find('customers.timeline-email-verified');
      await verified.handle(
        consumed(1, { accountId: ALICE, population: 'seller' }),
        delivery(20),
        system,
      );
      await verified.handle(
        consumed(2, { accountId: ALICE, population: 'admin' }),
        delivery(21),
        system,
      );
      expect(entriesOf(ALICE)).toEqual([]);
      await verified.handle(
        consumed(3, { accountId: ALICE, population: 'customer' }),
        delivery(22),
        system,
      );
      expect(entriesOf(ALICE).map((e) => e.kind)).toEqual(['email-verified']);
    });

    it('records each review event from its review id only, and throws on a refusal', async () => {
      const subscriptions = customerReviewTimelineSubscriptions(record);
      expect(subscriptions.map((s) => [s.name, s.event.type])).toEqual([
        ['customers.timeline-review-published', 'reviews.review-published.v1'],
        ['customers.timeline-review-held', 'reviews.review-held.v1'],
        ['customers.timeline-review-hidden', 'reviews.review-hidden.v1'],
        ['customers.timeline-review-restored', 'reviews.review-restored.v1'],
      ]);
      const hidden = subscriptions[2] as unknown as ReturnType<typeof find>;
      await hidden.handle(
        consumed(5, { reviewId: REVIEW, productId: id(0x301), sellerId: id(0x401) }),
        delivery(24),
        system,
      );
      expect(entriesOf(ALICE).map((e) => e.kind)).toEqual(['review-hidden']);
      reviewsDown = true;
      await expect(
        hidden.handle(
          consumed(6, { reviewId: REVIEW, productId: id(0x301), sellerId: id(0x401) }),
          delivery(25),
          system,
        ),
      ).rejects.toThrow(/refused: customers.unavailable/);
    });

    it('records a consent change with its channel only, once, and throws on a refusal', async () => {
      const subscriptions = customerConsentTimelineSubscriptions(record);
      expect(subscriptions.map((s) => [s.name, s.event.type])).toEqual([
        ['customers.timeline-consent-changed', 'legal.marketing-consent-changed.v1'],
      ]);
      const changed = subscriptions[0] as unknown as ReturnType<typeof find>;
      await changed.handle(
        consumed(7, { accountId: ALICE, channel: 'email' }),
        delivery(26),
        system,
      );
      // The same delivery again, and the same event on a new delivery: one entry.
      await changed.handle(
        consumed(7, { accountId: ALICE, channel: 'email' }),
        delivery(26),
        system,
      );
      await changed.handle(
        consumed(7, { accountId: ALICE, channel: 'email' }),
        delivery(27),
        system,
      );
      expect(entriesOf(ALICE)).toEqual([
        expect.objectContaining({
          kind: 'consent-changed',
          detail: 'email',
          ref: null,
          actorAccountId: null,
          occurredAt: T0,
          sourceEventId: id(0x207),
        }),
      ]);
      // An account identity does not know (erased) gets nothing; one it knows without a directory
      // row yet is retried.
      await changed.handle(
        consumed(8, { accountId: id<'Account'>(0xdead), channel: 'email' }),
        delivery(28),
        system,
      );
      expect(entriesOf(id<'Account'>(0xdead))).toEqual([]);
      await expect(
        changed.handle(consumed(9, { accountId: NEWBIE, channel: 'email' }), delivery(29), system),
      ).rejects.toThrow(/refused: customers.unavailable/);
    });

    it('refuses a consent change with a channel that is not a code', async () => {
      expect(
        await record.execute(system, {
          kind: 'consent-changed',
          accountId: ALICE,
          channel: 'E-mail <x>',
          eventId: id(0x120),
          occurredAt: T0,
          delivery: delivery(30),
        }),
      ).toEqual(err({ code: 'validation.failed' }));
      expect(entriesOf(ALICE)).toEqual([]);
    });

    it('throws on a refusal, so the delivery is retried', async () => {
      identityDown = true;
      await expect(
        find('customers.timeline-registered').handle(
          consumed(4, { accountId: NEWBIE }),
          delivery(23),
          system,
        ),
      ).rejects.toThrow(/refused: customers.unavailable/);
    });
  });
});
