import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../platform/events/event-subscriptions';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  ReadModelPeers,
  DirectoryRecordPeer,
  OrderStatsPeerValue,
} from './ports/customer-read-model-peers';
import type { ReadModelDependencies } from './read-model-dependencies';
import {
  CUSTOMER_EMAIL_CHANGED_SUBSCRIBER,
  customerReadModelSubscriptions,
} from '../presentation/subscribers/customer-read-model.subscriptions';
import { InMemoryReadModels } from './testing/in-memory-read-models';
import { ReadCustomerLastOrder } from './use-cases/read-customer-last-order.use-case';
import { ReadOwnLastOrder } from './use-cases/read-own-last-order.use-case';
import { ReconcileCustomerReadModels } from './use-cases/reconcile-customer-read-models.use-case';
import { SyncCustomerReadModel } from './use-cases/sync-customer-read-model.use-case';

// The customers read models on both Market fixtures: an event or the reconcile brings a customer's
// directory and stats rows in line with identity and ordering (a replace, so a repeat changes
// nothing); an erased account loses both rows; a peer that cannot answer writes nothing; the
// last-order read answers unknown for a customer it has no row for.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);
const delivery = (n: number): EventDelivery => ({
  eventId: id<'event'>(0xe0 + n),
  subscriber: 'customers.read-model-test',
  attempt: 1,
});

class FakePeers implements ReadModelPeers {
  accounts = new Map<string, DirectoryRecordPeer>();
  totals = new Map<string, OrderStatsPeerValue>();
  orderOwner = new Map<string, Id<'Account'>>();
  down = false;
  readonly identity = {
    customerDirectoryRecords: (_c: CallContext, ids: readonly Id<'Account'>[]) =>
      Promise.resolve(
        this.down
          ? err({ code: 'customers.unavailable' })
          : ok(ids.flatMap((a) => (this.accounts.has(a) ? [this.accounts.get(a)!] : []))),
      ),
    customerDirectoryPage: (
      _c: CallContext,
      r: { readonly after: Id<'Account'> | null; readonly limit: number },
    ) =>
      Promise.resolve(
        ok(
          [...this.accounts.values()]
            .filter((a) => r.after === null || a.accountId > r.after)
            .sort((a, b) => a.accountId.localeCompare(b.accountId))
            .slice(0, r.limit),
        ),
      ),
  };
  readonly ordering = {
    customerOrderStats: (_c: CallContext, accountId: Id<'Account'>) =>
      Promise.resolve(
        this.down
          ? err({ code: 'customers.unavailable' })
          : ok(
              this.totals.get(accountId) ?? {
                accountId,
                orderCount: 0,
                firstOrderAt: null,
                lastOrderAt: null,
                spentMinor: null,
                currency: null,
                refundCount: 0,
                refundedMinor: 0n,
              },
            ),
      ),
    customerOrderAccounts: (
      _c: CallContext,
      r: { readonly after: Id<'Account'> | null; readonly limit: number },
    ) =>
      Promise.resolve(
        ok({
          accountIds: [...this.totals.keys()]
            .filter((a) => r.after === null || a > r.after)
            .sort()
            .slice(0, r.limit) as Id<'Account'>[],
        }),
      ),
    orderNotice: (_c: CallContext, orderId: string) =>
      Promise.resolve(
        this.orderOwner.has(orderId)
          ? ok({ accountId: this.orderOwner.get(orderId)! })
          : err({ code: 'ordering.order-not-found' }),
      ),
    refundNotice: (_c: CallContext, r: { readonly orderId: string; readonly refundId: string }) =>
      Promise.resolve(
        this.orderOwner.has(r.orderId)
          ? ok({
              accountId: this.orderOwner.get(r.orderId)!,
              amount: { amount: 100n, currency: 'AUD' },
            })
          : err({ code: 'ordering.refund-not-found' }),
      ),
  };
}

const record = (
  accountId: Id<'Account'>,
  over: Partial<DirectoryRecordPeer> = {},
): DirectoryRecordPeer => ({
  accountId,
  email: 'Alice@Example.com',
  displayName: 'Alice A.',
  status: 'active',
  emailVerifiedAt: T0,
  signedUpAt: T0.subtract({ hours: 24 * 40 }),
  ...over,
});
const stats = (
  accountId: Id<'Account'>,
  over: Partial<OrderStatsPeerValue> = {},
): OrderStatsPeerValue => ({
  accountId,
  orderCount: 2,
  firstOrderAt: T0.subtract({ hours: 24 * 30 }),
  lastOrderAt: T0.subtract({ hours: 24 * 3 }),
  spentMinor: 25_000n,
  currency: 'AUD',
  refundCount: 1,
  refundedMinor: 1_000n,
  ...over,
});

describe.each(TEST_MARKET_IDS)('customer read models in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'read-model-system-abcd');
  const customer = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'read-model-customer-abcd',
    );
  let peers: FakePeers;
  let models: InMemoryReadModels;
  let units: FakeUnitOfWork;
  let deps: ReadModelDependencies;
  const sync = () => new SyncCustomerReadModel(gate, deps);

  beforeEach(() => {
    peers = new FakePeers();
    models = new InMemoryReadModels();
    units = new FakeUnitOfWork();
    deps = {
      identity: peers.identity,
      ordering: peers.ordering,
      unitOfWork: units,
      readModels: models,
      clock: new FixedClock(T0),
    };
    peers.accounts.set(ALICE, record(ALICE));
    peers.totals.set(ALICE, stats(ALICE));
  });

  it('copies the account and its order totals on an account event', async () => {
    const result = await sync().execute(system, { accountId: ALICE, delivery: delivery(1) });
    expect(result).toEqual(ok({ kept: true }));
    const key = `${market.marketId}:${ALICE}`;
    expect(models.directory.get(key)).toMatchObject({
      email: 'Alice@Example.com',
      status: 'active',
      emailVerified: true,
    });
    expect(models.stats.get(key)).toMatchObject({
      orderCount: 2,
      spentMinor: 25_000n,
      refundCount: 1,
    });
  });

  it('copies the new sign-in email on identity.account-email-changed.v1 (customers.read-model-email-changed)', async () => {
    const subscriber = customerReadModelSubscriptions(sync()).find(
      (registered) => registered.name === CUSTOMER_EMAIL_CHANGED_SUBSCRIBER,
    )!;
    expect(subscriber.event.type).toBe('identity.account-email-changed.v1');
    const event = (population: string, n: number) =>
      ({
        eventId: id<'event'>(0xf0 + n),
        type: 'identity.account-email-changed.v1',
        occurredAt: T0,
        market,
        aggregateType: 'account',
        aggregateId: ALICE,
        aggregateVersion: 5,
        correlationId: 'read-model-system-abcd',
        causationId: null,
        payload: { accountId: ALICE, population },
      }) as never;
    await sync().execute(system, { accountId: ALICE, delivery: delivery(1) });
    const key = `${market.marketId}:${ALICE}`;
    expect(models.directory.get(key)).toMatchObject({ email: 'Alice@Example.com' });
    // identity swapped the address: the directory follows the event.
    peers.accounts.set(ALICE, record(ALICE, { email: 'Alice.New@Mailbox.test' }));
    await subscriber.handle(event('customer', 1), delivery(2), system as SubscriberContext);
    expect(models.directory.get(key)).toMatchObject({ email: 'Alice.New@Mailbox.test' });
    // Another population's event is not a customer's: the row is left as it is.
    peers.accounts.set(ALICE, record(ALICE, { email: 'Ignored@Mailbox.test' }));
    await subscriber.handle(event('seller', 2), delivery(3), system as SubscriberContext);
    expect(models.directory.get(key)).toMatchObject({ email: 'Alice.New@Mailbox.test' });
  });

  it('follows a disabled account and an unverified email', async () => {
    peers.accounts.set(ALICE, record(ALICE, { status: 'disabled', emailVerifiedAt: null }));
    await sync().execute(system, { accountId: ALICE, delivery: delivery(2) });
    expect(models.directory.get(`${market.marketId}:${ALICE}`)).toMatchObject({
      status: 'disabled',
      emailVerified: false,
    });
  });

  it('replaces rather than increments: a later delivery of the same facts changes nothing', async () => {
    await sync().execute(system, { accountId: ALICE, delivery: delivery(3) });
    await sync().execute(system, { accountId: ALICE, delivery: delivery(4) });
    expect(models.stats.get(`${market.marketId}:${ALICE}`)).toMatchObject({
      orderCount: 2,
      spentMinor: 25_000n,
    });
    expect(models.directory.size).toBe(1);
  });

  it('finds the account of a paid order or a refund through ordering', async () => {
    peers.orderOwner.set(id<'Order'>(0x77), ALICE);
    expect(
      await sync().execute(system, { orderId: id<'Order'>(0x77), delivery: delivery(5) }),
    ).toEqual(ok({ kept: true }));
    expect(
      await sync().execute(system, {
        orderId: id<'Order'>(0x77),
        refundId: id<'Refund'>(0x78),
        delivery: delivery(6),
      }),
    ).toEqual(ok({ kept: true }));
    expect(models.stats.size).toBe(1);
  });

  it('removes both rows of an account identity no longer has', async () => {
    await sync().execute(system, { accountId: ALICE, delivery: delivery(7) });
    peers.accounts.delete(ALICE);
    expect(await sync().execute(system, { accountId: ALICE, delivery: delivery(8) })).toEqual(
      ok({ kept: false }),
    );
    expect(models.directory.size).toBe(0);
    expect(models.stats.size).toBe(0);
  });

  it('writes nothing and reports unavailable when a peer cannot answer', async () => {
    peers.down = true;
    expect(await sync().execute(system, { accountId: ALICE, delivery: delivery(9) })).toEqual(
      err({ code: 'customers.unavailable' }),
    );
    expect(models.directory.size).toBe(0);
  });

  it('refuses an id that is not an account id, and any actor but the system', async () => {
    expect(await sync().execute(system, { accountId: 'x', delivery: delivery(10) })).toEqual(
      err({ code: 'validation.failed' }),
    );
    const denied = await sync().execute(customer(ALICE), {
      accountId: ALICE,
      delivery: delivery(11),
    });
    expect(denied.ok).toBe(false);
  });

  it('backfills every account and refreshes every customer with an order', async () => {
    peers.accounts.set(BOB, record(BOB, { email: 'bob@example.com' }));
    const result = await new ReconcileCustomerReadModels(gate, deps).execute(system, {});
    expect(result).toEqual(ok({ directoryRows: 2, customersWithOrders: 1, swept: 0 }));
    expect(models.directory.size).toBe(2);
    // Bob never ordered: he still gets the all-zero stats row, so every customer sorts as a number.
    expect(models.stats.size).toBe(2);
    expect(models.stats.get(`${market.marketId}:${BOB}`)).toMatchObject({
      orderCount: 0,
      spentMinor: 0n,
      lastOrderAt: null,
    });
  });

  it('skips an order that is gone, still recording the delivery', async () => {
    const result = await sync().execute(system, {
      orderId: id<'Order'>(0x99),
      delivery: delivery(20),
    });
    expect(result).toEqual(ok({ kept: false }));
    expect(units.onceUnits).toHaveLength(1);
  });

  it('removes a row an erasure raced with, right after the write and in the sweep', async () => {
    // Identity answers once, then the account is erased before the second look.
    let reads = 0;
    const real = peers.identity.customerDirectoryRecords;
    peers.identity.customerDirectoryRecords = (c, ids) => {
      reads += 1;
      return reads === 1 ? real(c, ids) : Promise.resolve(ok([]));
    };
    expect(await sync().execute(system, { accountId: ALICE, delivery: delivery(21) })).toEqual(
      ok({ kept: false }),
    );
    expect(models.directory.size).toBe(0);

    // A stale row that no event removed is swept by the reconcile.
    peers.identity.customerDirectoryRecords = real;
    models.directory.set(`${market.marketId}:${BOB}`, {
      accountId: BOB,
      email: 'bob@example.com',
      displayName: null,
      status: 'active',
      emailVerified: false,
      signedUpAt: T0,
    });
    const swept = await new ReconcileCustomerReadModels(gate, deps).execute(system, {});
    expect(swept).toMatchObject({ ok: true, value: { swept: 1 } });
    expect(models.directory.has(`${market.marketId}:${BOB}`)).toBe(false);
  });

  describe('the last-order read', () => {
    it('answers the last confirmed order, null for none, and unknown for no row', async () => {
      const read = new ReadCustomerLastOrder(gate, deps);
      expect(await read.execute(system, { accountId: ALICE })).toEqual(
        err({ code: 'customers.customer-unknown' }),
      );
      await sync().execute(system, { accountId: ALICE, delivery: delivery(12) });
      expect(await read.execute(system, { accountId: ALICE })).toEqual(
        ok({ lastOrderAt: T0.subtract({ hours: 24 * 3 }) }),
      );
      peers.accounts.set(BOB, record(BOB));
      await sync().execute(system, { accountId: BOB, delivery: delivery(13) });
      expect(await read.execute(system, { accountId: BOB })).toEqual(ok({ lastOrderAt: null }));
    });

    it('lets a customer read only their own, and refuses a customer asking by id', async () => {
      await sync().execute(system, { accountId: ALICE, delivery: delivery(14) });
      const own = await new ReadOwnLastOrder(gate, deps).execute(customer(ALICE), {});
      expect(own).toEqual(ok({ lastOrderAt: T0.subtract({ hours: 24 * 3 }) }));
      expect(
        (await new ReadCustomerLastOrder(gate, deps).execute(customer(ALICE), { accountId: ALICE }))
          .ok,
      ).toBe(false);
      expect((await new ReadOwnLastOrder(gate, deps).execute(system, {})).ok).toBe(false);
    });
  });
});
