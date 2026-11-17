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
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  CUSTOMER_CODE_PATTERN,
  normalizeCodeTerm,
  parseSellerCustomerSelector,
  sellerCustomerEntriesOf,
} from '../domain/seller-customers';
import { RandomCustomerCodes } from '../infrastructure/random-customer-codes';
import type {
  CustomerReadModelPeers,
  SellerCustomerOrderPeerValue,
  SellerOrderTotalsPeerValue,
} from './ports/customer-read-model-peers';
import { trendMonths, type SellerCustomerDependencies } from './seller-customers-flow';
import { RecordingAudit } from './testing/in-memory-account-deletion';
import { InMemoryReadModels } from './testing/in-memory-read-models';
import {
  InMemorySellerCustomers,
  ScriptedCustomerCodes,
} from './testing/in-memory-seller-customers';
import { AdminSellerCustomersList } from './use-cases/admin-seller-customers-list.use-case';
import { AdminSellerCustomersSummary } from './use-cases/admin-seller-customers-summary.use-case';
import { ReconcileSellerCustomers } from './use-cases/reconcile-seller-customers.use-case';
import { SellerCustomerDetail } from './use-cases/seller-customer-detail.use-case';
import { SellerCustomersCodes } from './use-cases/seller-customers-codes.use-case';
import { SellerCustomersExport } from './use-cases/seller-customers-export.use-case';
import { SellerCustomersList } from './use-cases/seller-customers-list.use-case';
import { SyncSellerCustomers } from './use-cases/sync-seller-customers.use-case';

// The per-seller customers (customers management phase 3) on both Market fixtures: a sync from
// ordering's per-seller totals and engagement's follows replaces the customer's rows; each seller
// knows the customer by its own code (kept while the relation lasts) and first name only; a seller
// reads its own rows only; the admin tab sees the account; erasure leaves nothing.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-16T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);
const SHOP = id<'Seller'>(0x51);
const RIVAL = id<'Seller'>(0x52);
const delivery = (n: number): EventDelivery => ({
  eventId: id<'event'>(0xe0 + n),
  subscriber: 'customers.seller-customers-test',
  attempt: 1,
});

class FakePeers implements CustomerReadModelPeers {
  totals = new Map<string, SellerOrderTotalsPeerValue[]>();
  follows = new Map<string, { sellerId: Id<'Seller'>; followedAt: Temporal.Instant }[]>();
  orders: SellerCustomerOrderPeerValue[] = [];
  orderOwner = new Map<string, Id<'Account'>>();
  ordersAsked: { accountId: Id<'Account'>; actor: string }[] = [];
  ordersDenied = false;
  down = false;
  /** Accounts whose stats read fails (one bad account in a reconcile run). */
  failing = new Set<string>();
  readonly identity = {
    customerDirectoryRecords: () => Promise.resolve(ok([])),
    customerDirectoryPage: () => Promise.resolve(ok([])),
  };
  readonly ordering = {
    customerOrderStats: () => Promise.resolve(err({ code: 'unused' })),
    customerOrderAccounts: () => Promise.resolve(ok({ accountIds: [] })),
    orderNotice: (_c: CallContext, orderId: string) =>
      Promise.resolve(
        this.orderOwner.has(orderId)
          ? ok({ accountId: this.orderOwner.get(orderId)! })
          : err({ code: 'ordering.order-not-found' }),
      ),
    refundNotice: () => Promise.resolve(err({ code: 'ordering.refund-not-found' })),
    customerSellerStats: (_c: CallContext, accountId: Id<'Account'>) =>
      Promise.resolve(
        this.down || this.failing.has(accountId)
          ? err({ code: 'ordering.unavailable' })
          : ok(this.totals.get(accountId) ?? []),
      ),
    sellerCustomerOrders: (
      context: CallContext,
      request: {
        readonly accountId: Id<'Account'>;
        readonly page: number;
        readonly pageSize: number;
      },
    ) => {
      this.ordersAsked.push({ accountId: request.accountId, actor: context.actor.kind });
      return Promise.resolve(
        this.ordersDenied
          ? err({ code: 'access.denied' })
          : ok({ items: this.orders, total: this.orders.length }),
      );
    },
  };
  readonly engagement = {
    followsOfAccount: (_c: CallContext, accountId: Id<'Account'>) =>
      Promise.resolve(
        this.down ? err({ code: 'engagement.unavailable' }) : ok(this.follows.get(accountId) ?? []),
      ),
  };
}

describe('per-seller customer codes and selectors', () => {
  it('draws codes in the Crockford alphabet and reads a typed code back', () => {
    const codes = new RandomCustomerCodes();
    for (let n = 0; n < 200; n += 1) expect(codes.next()).toMatch(CUSTOMER_CODE_PATTERN);
    expect(normalizeCodeTerm(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeCodeTerm('o1il')).toBe('0111');
    expect(normalizeCodeTerm('ABCU')).toBeNull();
    expect(normalizeCodeTerm('123456789')).toBeNull();
  });

  it('keeps one entry per seller the customer bought from or follows', () => {
    const entries = sellerCustomerEntriesOf(
      ALICE,
      [
        {
          sellerId: SHOP,
          orderCount: 2,
          firstOrderAt: T0,
          lastOrderAt: T0,
          spentMinor: -5n,
          currency: 'AUD',
        },
        {
          sellerId: RIVAL,
          orderCount: 0,
          firstOrderAt: T0,
          lastOrderAt: T0,
          spentMinor: 0n,
          currency: 'AUD',
        },
      ],
      [{ sellerId: SHOP, followedAt: T0 }],
    );
    expect(entries).toEqual([
      expect.objectContaining({ sellerId: SHOP, orderCount: 2, spentMinor: 0n, follower: true }),
    ]);
  });

  it('refuses unknown filter keys, backwards ranges and a one-symbol search', () => {
    expect(parseSellerCustomerSelector({ filters: { email: 'x' } })).toMatchObject({ ok: false });
    expect(parseSellerCustomerSelector({ filters: { ordersMin: 5, ordersMax: 1 } })).toMatchObject({
      ok: false,
    });
    expect(parseSellerCustomerSelector({ q: 'A' })).toMatchObject({ ok: false });
    expect(parseSellerCustomerSelector({ q: 'abcd-e' })).toMatchObject({
      ok: true,
      value: { codePrefix: 'ABCD-E' },
    });
  });

  it('cuts the trend in the zone given, oldest month first', () => {
    const months = trendMonths(
      Temporal.Instant.from('2026-01-31T15:00:00Z'),
      'Australia/Brisbane',
      3,
    );
    expect(months.map((m) => m.month)).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(months[2]!.from.toString()).toBe('2026-01-31T14:00:00Z');
  });
});

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'ZZD'],
] as const)('per-seller customers in market %s', (code, currency) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const seller = (sellerId: Id<'Seller'>, extra: object = {}, target = market): CallContext => {
    const context = testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'seller',
        accountId: id<'Account'>(0x5000 + Number(`0x${sellerId.slice(-2)}`)),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `seller-customers-${code}-abcd`,
    );
    return Object.keys(extra).length === 0
      ? context
      : { ...context, actor: { ...context.actor, ...extra } };
  };
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id<'Account'>(0xad),
      sessionId: id<'Session'>(0x62),
      sellerId: null,
    }),
    `seller-customers-admin-abcd`,
  );
  const system = testCallContext(market, 'system');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let peers: FakePeers;
  let rows: InMemorySellerCustomers;
  let readModels: InMemoryReadModels;
  let audit: RecordingAudit;
  let codes: ScriptedCustomerCodes;
  let uc: {
    sync: SyncSellerCustomers;
    reconcile: ReconcileSellerCustomers;
    list: SellerCustomersList;
    codes: SellerCustomersCodes;
    export: SellerCustomersExport;
    detail: SellerCustomerDetail;
    adminList: AdminSellerCustomersList;
    summary: AdminSellerCustomersSummary;
  };
  let n = 0;
  const sync = (accountId: Id<'Account'>) =>
    uc.sync.execute(system, { accountId, delivery: delivery((n += 1)) });
  const directory = (accountId: Id<'Account'>, name: string | null, target = market) => {
    void readModels.upsertDirectory(target, {
      accountId,
      email: `${accountId}@example.test`,
      displayName: name,
      status: 'active',
      emailVerified: true,
      signedUpAt: T0,
    });
    rows.names.set(`${target.marketId}:${accountId}`, name);
  };
  const bought = (sellerId: Id<'Seller'>, orderCount: number, spentMinor: bigint) => ({
    sellerId,
    orderCount,
    firstOrderAt: T0,
    lastOrderAt: T0.add({ hours: orderCount }),
    spentMinor,
    currency,
  });

  beforeEach(() => {
    clock = new FixedClock(T0);
    peers = new FakePeers();
    rows = new InMemorySellerCustomers();
    readModels = new InMemoryReadModels();
    audit = new RecordingAudit();
    codes = new ScriptedCustomerCodes();
    const deps: SellerCustomerDependencies = {
      ...peers,
      identity: peers.identity,
      ordering: peers.ordering,
      engagement: peers.engagement,
      unitOfWork: new FakeUnitOfWork(),
      sellerCustomers: rows,
      codes,
      readModels,
      clock,
      audit,
      sheetWriter: {
        xlsx: async function* (_name, lines) {
          for await (const line of lines) yield new TextEncoder().encode(line.join('\t') + '\n');
        },
      },
      zones: { zoneOf: () => markets.get(market.marketId).timezone },
    };
    uc = {
      sync: new SyncSellerCustomers(gate, deps),
      reconcile: new ReconcileSellerCustomers(gate, deps),
      list: new SellerCustomersList(gate, deps),
      codes: new SellerCustomersCodes(gate, deps),
      export: new SellerCustomersExport(gate, deps),
      detail: new SellerCustomerDetail(gate, deps),
      adminList: new AdminSellerCustomersList(gate, deps),
      summary: new AdminSellerCustomersSummary(gate, deps),
    };
    directory(ALICE, 'Maryam Rahimi');
    directory(BOB, 'Omar');
  });

  it('gives each seller its own code, keeps it across syncs, and removes the row when the relation ends', async () => {
    peers.totals.set(ALICE, [bought(SHOP, 2, 4500n), bought(RIVAL, 1, 900n)]);
    expect(await sync(ALICE)).toEqual({ ok: true, value: { rows: 2 } });
    const shopCode = rows.rows.find((row) => row.sellerId === SHOP)!.code;
    const rivalCode = rows.rows.find((row) => row.sellerId === RIVAL)!.code;
    expect(shopCode).not.toBe(rivalCode);

    peers.totals.set(ALICE, [bought(SHOP, 3, 6000n)]);
    peers.follows.set(ALICE, [{ sellerId: RIVAL, followedAt: T0.add({ hours: 24 }) }]);
    await sync(ALICE);
    expect(rows.rows.find((row) => row.sellerId === SHOP)).toMatchObject({
      code: shopCode,
      orderCount: 3,
      spentMinor: 6000n,
      follower: false,
    });
    expect(rows.rows.find((row) => row.sellerId === RIVAL)).toMatchObject({
      code: rivalCode,
      orderCount: 0,
      follower: true,
    });

    peers.follows.set(ALICE, []);
    await sync(ALICE);
    expect(rows.rows.map((row) => row.sellerId)).toEqual([SHOP]);
  });

  it('draws again when a code is taken at the seller', async () => {
    codes.queued.push('AAAA-AAAA', 'AAAA-AAAA', 'BBBB-BBBB');
    peers.totals.set(ALICE, [bought(SHOP, 1, 100n)]);
    peers.totals.set(BOB, [bought(SHOP, 1, 100n)]);
    await sync(ALICE);
    await sync(BOB);
    expect(rows.rows.map((row) => row.code).sort()).toEqual(['AAAA-AAAA', 'BBBB-BBBB']);
  });

  it('writes nothing for an account without a directory row, and nothing when a peer is down', async () => {
    const carol = id<'Account'>(0xc3);
    peers.totals.set(carol, [bought(SHOP, 1, 100n)]);
    expect(await sync(carol)).toEqual({ ok: true, value: { rows: 0 } });
    peers.down = true;
    peers.totals.set(ALICE, [bought(SHOP, 1, 100n)]);
    expect(await sync(ALICE)).toEqual({ ok: false, error: { code: 'customers.unavailable' } });
    expect(rows.rows).toEqual([]);
  });

  it('handles a delivery once, and a paid order that is gone as handled', async () => {
    peers.totals.set(ALICE, [bought(SHOP, 1, 100n)]);
    const once = delivery(99);
    expect(await uc.sync.execute(system, { accountId: ALICE, delivery: once })).toEqual({
      ok: true,
      value: { rows: 1 },
    });
    peers.totals.set(ALICE, [bought(SHOP, 5, 100n)]);
    expect(await uc.sync.execute(system, { accountId: ALICE, delivery: once })).toEqual({
      ok: true,
      value: { rows: 0 },
    });
    expect(rows.rows[0]!.orderCount).toBe(1);
    expect(await uc.sync.execute(system, { orderId: 'gone', delivery: delivery(98) })).toEqual({
      ok: true,
      value: { rows: 0 },
    });
    peers.orderOwner.set('order-1', BOB);
    peers.totals.set(BOB, [bought(SHOP, 1, 50n)]);
    await uc.sync.execute(system, { orderId: 'order-1', delivery: delivery(97) });
    expect(rows.rows.map((row) => row.accountId).sort()).toEqual([ALICE, BOB].sort());
    expect(
      await uc.sync.execute(seller(SHOP), { accountId: ALICE, delivery: delivery(96) }),
    ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
  });

  it('reconciles every customer of the directory', async () => {
    peers.totals.set(ALICE, [bought(SHOP, 1, 100n)]);
    peers.follows.set(BOB, [{ sellerId: SHOP, followedAt: T0 }]);
    expect(await uc.reconcile.execute(system, {})).toEqual({
      ok: true,
      value: { accounts: 2, rows: 2, failed: 0, capped: false },
    });
  });

  it('goes on past an account whose sync fails, and counts it', async () => {
    peers.totals.set(ALICE, [bought(SHOP, 1, 100n)]);
    peers.follows.set(BOB, [{ sellerId: SHOP, followedAt: T0 }]);
    peers.failing.add(ALICE);
    expect(await uc.reconcile.execute(system, {})).toEqual({
      ok: true,
      value: { accounts: 1, rows: 1, failed: 1, capped: false },
    });
  });

  describe('the seller list', () => {
    beforeEach(async () => {
      peers.totals.set(ALICE, [bought(SHOP, 2, 4500n), bought(RIVAL, 7, 99_000n)]);
      peers.follows.set(BOB, [{ sellerId: SHOP, followedAt: T0.add({ hours: 48 }) }]);
      await sync(ALICE);
      await sync(BOB);
    });

    it('shows the seller its own customers by code and first name only', async () => {
      const page = await uc.list.execute(seller(SHOP), { page: 1 });
      if (!page.ok) throw new Error(JSON.stringify(page.error));
      expect(page.value.counts).toEqual({ all: 2, buyers: 1, followers: 1 });
      expect(page.value.paging).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      const alice = page.value.items.find((row) => row.orderCount > 0)!;
      expect(alice.code).toMatch(/^\d{4}-\d{4}$/);
      expect(alice).toEqual({
        code: alice.code,
        firstName: 'Maryam',
        orderCount: 2,
        firstOrderAt: T0.toString(),
        lastOrderAt: T0.add({ hours: 2 }).toString(),
        spentMinor: '4500',
        currency,
        follower: false,
        followedAt: null,
        exclusive: false,
        since: T0.toString(),
      });
      const text = JSON.stringify(page.value);
      for (const secret of [ALICE, BOB, '@example.test', 'Rahimi', '99000']) {
        expect(text).not.toContain(secret);
      }
    });

    it('filters by tab, code and numbers, and pages by cursor', async () => {
      const followers = await uc.list.execute(seller(SHOP), { view: 'followers' });
      expect(followers).toMatchObject({ ok: true, value: { items: [{ firstName: 'Omar' }] } });
      const aliceCode = rows.rows.find((r) => r.sellerId === SHOP && r.accountId === ALICE)!.code;
      const byCode = await uc.list.execute(seller(SHOP), { q: aliceCode.toLowerCase() });
      expect(byCode).toMatchObject({ ok: true, value: { items: [{ code: aliceCode }] } });
      const spent = await uc.list.execute(seller(SHOP), { filters: { spentMin: '1000' } });
      expect(spent).toMatchObject({ ok: true, value: { items: [{ code: aliceCode }] } });
      const first = await uc.list.execute(seller(SHOP), {
        limit: 1,
        sort: 'code',
        direction: 'asc',
      });
      expect(first).toMatchObject({ ok: true, value: { nextCursor: 'o1', paging: null } });
      expect(await uc.list.execute(seller(SHOP), { sort: 'email' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('refuses another population, a Login as Seller session and another Market', async () => {
      expect(await uc.list.execute(admin, {})).toMatchObject({ ok: false });
      expect(
        await uc.list.execute(seller(SHOP, { actingAs: { adminAccountId: 'x' } }), {}),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(await uc.list.execute(seller(SHOP, {}, other), {})).toMatchObject({
        ok: true,
        value: { items: [], counts: { all: 0, buyers: 0, followers: 0 } },
      });
    });

    it("answers the matching codes, and never another seller's", async () => {
      const shop = await uc.codes.execute(seller(SHOP), { view: 'buyers' });
      const rival = await uc.codes.execute(seller(RIVAL), {});
      if (!shop.ok || !rival.ok) throw new Error('codes refused');
      expect(shop.value.total).toBe(1);
      expect(rival.value.codes).toHaveLength(1);
      expect(rival.value.codes[0]).not.toBe(shop.value.codes[0]);
    });

    it("opens one customer by the seller's code with the seller's orders of them", async () => {
      const aliceCode = rows.rows.find((r) => r.sellerId === SHOP && r.accountId === ALICE)!.code;
      peers.orders = [
        {
          sellerOrderId: 'so-1',
          orderId: 'o-1',
          paidAt: T0,
          total: { amount: 2500n, currency },
          fulfilment: 'delivered',
          deliveredAt: T0.add({ hours: 24 }),
        },
      ];
      const opened = await uc.detail.execute(seller(SHOP), { code: aliceCode.toLowerCase() });
      expect(opened).toMatchObject({
        ok: true,
        value: {
          customer: { code: aliceCode, firstName: 'Maryam' },
          orders: { total: 1, items: [{ sellerOrderId: 'so-1', totalMinor: '2500', currency }] },
        },
      });
      expect(JSON.stringify(opened)).not.toContain(ALICE);
      expect(peers.ordersAsked).toEqual([{ accountId: ALICE, actor: 'authenticated' }]);
      // The rival's code for Alice opens nothing at this shop.
      const rivalCode = rows.rows.find((r) => r.sellerId === RIVAL)!.code;
      expect(await uc.detail.execute(seller(SHOP), { code: rivalCode })).toEqual({
        ok: false,
        error: { code: 'customers.seller-customer-not-found' },
      });
      peers.ordersDenied = true;
      expect(await uc.detail.execute(seller(SHOP), { code: aliceCode })).toMatchObject({
        ok: true,
        value: { orders: null },
      });
      expect(await uc.detail.execute(seller(SHOP), { code: 'nope' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('exports codes and first names, audited with the count only', async () => {
      const file = await uc.export.execute(seller(SHOP), { format: 'csv' });
      if (!file.ok) throw new Error(JSON.stringify(file.error));
      let text = '';
      for await (const chunk of file.value.chunks) text += chunk as string;
      expect(text.split('\r\n').filter(Boolean)).toHaveLength(3);
      expect(text).toContain('Maryam');
      expect(text).not.toContain('Rahimi');
      expect(text).not.toContain(ALICE);
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'customers.seller-customers.exported',
          targetId: SHOP,
          after: { format: 'csv', rowCount: 2, selection: 'filter' },
        }),
      ]);
      const named = await uc.export.execute(seller(SHOP), {
        format: 'xlsx',
        codes: [rows.rows.find((r) => r.sellerId === RIVAL)!.code],
      });
      expect(named).toMatchObject({ ok: true });
      expect(audit.entries[1]).toMatchObject({ after: { rowCount: 0, selection: 'codes' } });
    });

    it("shows the admin a seller's customers with the account, and the summary", async () => {
      const page = await uc.adminList.execute(admin, { sellerId: SHOP, page: 1 });
      expect(page).toMatchObject({ ok: true, value: { paging: { total: 2 } } });
      if (page.ok)
        expect(page.value.items.map((row) => row.accountId).sort()).toEqual([ALICE, BOB].sort());
      expect(await uc.adminList.execute(seller(SHOP), { sellerId: SHOP })).toMatchObject({
        ok: false,
      });
      expect(await uc.adminList.execute(admin, { sellerId: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      const summary = await uc.summary.execute(admin, { sellerId: SHOP });
      if (!summary.ok) throw new Error('summary refused');
      expect(summary.value.counts).toEqual({ all: 2, buyers: 1, followers: 1 });
      expect(summary.value.months).toHaveLength(12);
      expect(summary.value.months.at(-1)).toMatchObject({ newBuyers: 1, newFollowers: 1 });
    });

    it('leaves no row once the account is erased', async () => {
      rows.removeAccount(market, ALICE);
      await readModels.removeAllOf(market, ALICE);
      await sync(ALICE);
      expect(rows.rows.some((row) => row.accountId === ALICE)).toBe(false);
    });
  });
});
