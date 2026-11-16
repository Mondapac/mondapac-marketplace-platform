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
