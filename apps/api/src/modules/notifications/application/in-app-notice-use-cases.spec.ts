import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { expectSystemOnly } from '../../../../test/support/system-only-denial';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDeclaration, AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OrderingFacade, OrderNotice } from '../../ordering';
import {
  NOTICE_PAGE_SIZE,
  NOTICES_PER_SELLER,
  parseNoticeParams,
  SELLER_ORDER_PAID,
} from '../domain/in-app-notice';
import type { InAppNoticeDependencies } from './in-app-notice-flow';
import type {
  InAppNoticeRepository,
  NewSellerNotice,
  NoticeFilter,
  SellerNoticeScope,
  StoredNotice,
} from './ports/in-app-notice.repository';
import { CountOwnUnreadNotices } from './use-cases/count-own-unread-notices.use-case';
import { ListOwnNotices } from './use-cases/list-own-notices.use-case';
import { MarkOwnNoticesRead } from './use-cases/mark-own-notices-read.use-case';
import { PurgeExpiredNotices } from './use-cases/purge-expired-notices.use-case';
import { RecordSellerOrderNotices } from './use-cases/record-seller-order-notices.use-case';

// The in-app notices in memory on both Market fixtures: a paid order becomes one "New order"
// notice per seller order, once; a seller-side member sees only their own seller's notices, only
// while they hold `ordering.seller-order.view`, and reads them for themselves only.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-17T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_A = id<'Seller'>(0x5a);
const SELLER_B = id<'Seller'>(0x5b);
const MEMBER_1 = id<'Account'>(0xa1);
const MEMBER_2 = id<'Account'>(0xa2);
const MEMBER_B = id<'Account'>(0xb1);
const ORDER = '01990000-0000-7000-8000-0000000000d1';
const NOTICE: OrderNotice = {
  orderId: ORDER,
  accountId: id<'Account'>(0xc1),
  sellerOrders: [
    {
      sellerOrderId: id<'SellerOrder'>(0x21),
      sellerId: SELLER_A,
      lines: [
        { offerId: id<'Offer'>(0x31), quantity: 2 },
        { offerId: id<'Offer'>(0x32), quantity: 1 },
      ],
    },
    {
      sellerOrderId: id<'SellerOrder'>(0x22),
      sellerId: SELLER_B,
      lines: [{ offerId: id<'Offer'>(0x33), quantity: 4 }],
    },
  ],
};

/** The table in memory, with the same scope rules as the Prisma repository. */
class MemoryNotices implements InAppNoticeRepository {
  rows: (NewSellerNotice & { market: string })[] = [];
  reads = new Set<string>();
  private inScope(market: MarketContext, scope: SellerNoticeScope) {
    return this.rows
      .filter(
        (row) =>
          row.market === market.marketId &&
          row.sellerId === scope.sellerId &&
          scope.kinds.includes(row.kind) &&
          Temporal.Instant.compare(row.createdAt, scope.since) >= 0,
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }
  private stored(row: NewSellerNotice, accountId: string): StoredNotice {
    return {
      id: row.id,
      kind: row.kind,
      params: row.params,
      createdAt: row.createdAt,
      read: this.reads.has(`${row.id}|${accountId}`),
    };
  }
  addForSellers(market: MarketContext, notices: readonly NewSellerNotice[]) {
    this.rows.push(...notices.map((notice) => ({ ...notice, market: market.marketId })));
    return Promise.resolve();
  }
  trimSeller(market: MarketContext, sellerId: Id<'Seller'>, keep: number) {
    const mine = this.rows
      .filter((row) => row.market === market.marketId && row.sellerId === sellerId)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const gone = new Set(mine.slice(keep).map((row) => row.id));
    this.rows = this.rows.filter((row) => !gone.has(row.id));
    return Promise.resolve(gone.size);
  }
  listForSeller(
    market: MarketContext,
    scope: SellerNoticeScope,
    page: { before: Id<'InAppNotice'> | null; limit: number; show: NoticeFilter },
  ) {
    const isRead = (row: NewSellerNotice) => this.reads.has(`${row.id}|${scope.accountId}`);
    return Promise.resolve(
      this.inScope(market, scope)
        .filter((row) => page.before === null || row.id < page.before)
        .filter((row) => page.show === 'all' || (page.show === 'read') === isRead(row))
        .slice(0, page.limit)
        .map((row) => this.stored(row, scope.accountId)),
    );
  }
  unreadForSeller(market: MarketContext, scope: SellerNoticeScope) {
    const unread = this.inScope(market, scope)
      .map((row) => this.stored(row, scope.accountId))
      .filter((row) => !row.read);
    return Promise.resolve({ count: unread.length, newest: unread[0] ?? null });
  }
  existsForSeller(market: MarketContext, scope: SellerNoticeScope, noticeId: Id<'InAppNotice'>) {
    return Promise.resolve(this.inScope(market, scope).some((row) => row.id === noticeId));
  }
  unreadIdsForSeller(
    market: MarketContext,
    scope: SellerNoticeScope,
    ids: readonly Id<'InAppNotice'>[] | 'all',
  ) {
    return Promise.resolve(
      this.inScope(market, scope)
        .filter((row) => ids === 'all' || ids.includes(row.id))
        .filter((row) => !this.reads.has(`${row.id}|${scope.accountId}`))
        .map((row) => row.id),
    );
  }
  markRead(_market: MarketContext, accountId: Id<'Account'>, ids: readonly Id<'InAppNotice'>[]) {
    let added = 0;
    for (const noticeId of ids) {
      const key = `${noticeId}|${accountId}`;
      if (!this.reads.has(key)) added += 1;
      this.reads.add(key);
    }
    return Promise.resolve(added);
  }
  purgeBefore(market: MarketContext, cutoff: Temporal.Instant) {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (row) =>
        row.market !== market.marketId || Temporal.Instant.compare(row.createdAt, cutoff) >= 0,
    );
    return Promise.resolve(before - this.rows.length);
  }
}

class CountingIds implements IdGenerator {
  n = 0x1000;
  next<K extends string>(): Id<K> {
    this.n += 1;
    return id<K>(this.n);
  }
}

describe('parseNoticeParams', () => {
  it('keeps only the known fields of a seller order notice', () => {
    expect(
      parseNoticeParams(SELLER_ORDER_PAID, {
        sellerOrderId: id(0x21) as string,
        items: 3,
        name: 'leaked',
      }),
    ).toEqual({ sellerOrderId: id(0x21), items: 3 });
  });

  it.each([
    ['an unknown kind', 'seller.other', { sellerOrderId: id(1), items: 1 }],
    ['an array', SELLER_ORDER_PAID, []],
    ['a bad id', SELLER_ORDER_PAID, { sellerOrderId: 'x', items: 1 }],
    ['a negative count', SELLER_ORDER_PAID, { sellerOrderId: id(1), items: -1 }],
    ['a fractional count', SELLER_ORDER_PAID, { sellerOrderId: id(1), items: 1.5 }],
    ['null', SELLER_ORDER_PAID, null],
  ])('refuses %s', (_label, kind, raw) => {
    expect(parseNoticeParams(kind, raw)).toBeNull();
  });
});

describe.each([['AU'], ['ZZ']] as const)('in-app notices in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const system = testCallContext(market, 'system', 'notice-sys-0001');

  let notices: MemoryNotices;
  let unitOfWork: FakeUnitOfWork;
  let clock: FixedClock;
  let orderNotice: ReturnType<OrderingFacade['orderNotice']>;
  /** The accounts that do NOT hold ordering.seller-order.view. */
  let withoutOrders: Set<string>;
  let checks: string[];
  let deps: InAppNoticeDependencies;
  let nextEvent: number;

  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const member = (accountId: Id<'Account'>, sellerId: Id<'Seller'>, on = market) =>
    testCallContext(
      on,
      testAuthenticatedActor(on, {
        population: 'seller',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      'notice-member-0001',
    );
  const delivery = (eventNo: number): EventDelivery => ({
    eventId: id<'event'>(0xe00 + eventNo),
    subscriber: 'notifications.seller-order-notice',
    attempt: 1,
  });
  const record = (eventNo = nextEvent++) =>
    new RecordSellerOrderNotices(gate, deps).execute(system, {
      delivery: delivery(eventNo),
      orderId: ORDER,
    });
  const list = (context: CallContext, before?: unknown, show?: unknown) =>
    new ListOwnNotices(gate, deps).execute(context, {
      ...(before === undefined ? {} : { before }),
      ...(show === undefined ? {} : { show }),
    });
  const count = (context: CallContext) =>
    new CountOwnUnreadNotices(gate, deps).execute(context, {});
  const mark = (context: CallContext, target: { all: true } | { id: unknown }) =>
    new MarkOwnNoticesRead(gate, deps).execute(context, { target });

  beforeEach(() => {
    notices = new MemoryNotices();
    unitOfWork = new FakeUnitOfWork();
    clock = new FixedClock(T0);
    orderNotice = Promise.resolve(ok(NOTICE));
    withoutOrders = new Set();
    checks = [];
    nextEvent = 1;
    const authorisation: AuthorisationCheck = {
      check: (context: CallContext, declaration: AccessDeclaration) => {
        checks.push(declaration.name);
        const actor = context.actor;
        const allowed =
          actor.kind === 'authenticated' &&
          declaration.rule.kind === 'permissions' &&
          (declaration.rule.allOf as readonly string[]).includes('ordering.seller-order.view') &&
          !withoutOrders.has(actor.accountId);
        return Promise.resolve(
          allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    deps = {
      unitOfWork,
      notices,
      ordering: { orderNotice: () => orderNotice } as unknown as OrderingFacade,
      authorisation,
      ids: new CountingIds(),
      clock,
    };
  });

  describe('recording', () => {
    it('writes one "New order" notice per seller order, with ids and counts only', async () => {
      expect(await record()).toEqual(ok({ code: 'notices.recorded', notices: 2 }));

      expect(
        notices.rows.map(({ sellerId, kind, params, market: m }) => ({
          sellerId,
          kind,
          params,
          m,
        })),
      ).toEqual([
        {
          sellerId: SELLER_A,
          kind: SELLER_ORDER_PAID,
          params: { sellerOrderId: id(0x21), items: 3 },
          m: code,
        },
        {
          sellerId: SELLER_B,
          kind: SELLER_ORDER_PAID,
          params: { sellerOrderId: id(0x22), items: 4 },
          m: code,
        },
      ]);
      expect(unitOfWork.onceUnits).toEqual([{ market: code, options: {} }]);
    });

    it('adds nothing for a repeated delivery', async () => {
      await record(7);
      expect(await record(7)).toEqual(ok({ code: 'notices.already-handled' }));
      expect(notices.rows).toHaveLength(2);
    });

    it('marks the delivery and writes nothing when the order is gone', async () => {
      orderNotice = Promise.resolve({ ok: false, error: { code: 'ordering.order-not-found' } });
      expect(await record()).toEqual(ok({ code: 'notices.skipped', reason: 'order.gone' }));
      expect(notices.rows).toEqual([]);
      expect(unitOfWork.handled.size).toBe(1);
    });

    it('throws a read fault back to the delivery and marks nothing', async () => {
      orderNotice = Promise.resolve({ ok: false, error: { code: 'validation.failed' } });
      await expect(record()).rejects.toThrow('the order could not be read');
      expect(unitOfWork.handled.size).toBe(0);
    });

    it(`keeps the newest ${NOTICES_PER_SELLER} notices of a seller`, async () => {
      for (let n = 0; n < NOTICES_PER_SELLER; n += 1) await record();
      expect(notices.rows.filter((row) => row.sellerId === SELLER_A)).toHaveLength(
        NOTICES_PER_SELLER,
      );
      const oldest = notices.rows.find((row) => row.sellerId === SELLER_A)!.id;

      await record();

      const mine = notices.rows.filter((row) => row.sellerId === SELLER_A);
      expect(mine).toHaveLength(NOTICES_PER_SELLER);
      expect(mine.some((row) => row.id === oldest)).toBe(false);
    });

    it('is system-only', async () => {
      await expectSystemOnly(code, (context) =>
        new RecordSellerOrderNotices(gate, deps).execute(context, {
          delivery: delivery(1),
          orderId: ORDER,
        }),
      );
      await expectSystemOnly(code, (context) =>
        new PurgeExpiredNotices(gate, deps).execute(context, {}),
      );
    });
  });

  describe('reading', () => {
    beforeEach(async () => {
      await record();
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      await record();
    });

    it("shows a member their own seller's notices, newest first, with the item link fields", async () => {
      const result = await list(member(MEMBER_1, SELLER_A));

      expect(result.ok && result.value.items.map((item) => item.params)).toEqual([
        { sellerOrderId: id(0x21), items: 3 },
        { sellerOrderId: id(0x21), items: 3 },
      ]);
      expect(result.ok && result.value.items[0]!.createdAt).toBe('2026-10-17T10:05:00Z');
      expect(result.ok && result.value.next).toBeNull();
      expect(checks).toEqual(['notifications.see-seller-order-notices']);
      // No customer data reaches the notice.
      expect(JSON.stringify(result)).not.toContain(NOTICE.accountId);
    });

    it('never shows another seller, or the same seller in another Market', async () => {
      const b = await list(member(MEMBER_B, SELLER_B));
      expect(b.ok && b.value.items.every((item) => item.params.sellerOrderId === id(0x22))).toBe(
        true,
      );

      expect(await list(member(MEMBER_1, SELLER_A, other))).toEqual(ok({ items: [], next: null }));
    });

    it('hides order notices from a member without ordering.seller-order.view, at once', async () => {
      withoutOrders.add(MEMBER_2);
      expect(await list(member(MEMBER_2, SELLER_A))).toEqual(ok({ items: [], next: null }));
      expect(await count(member(MEMBER_2, SELLER_A))).toEqual(ok({ unread: 0, newest: null }));
      const first = notices.rows[0]!.id;
      expect(await mark(member(MEMBER_2, SELLER_A), { id: first })).toEqual({
        ok: false,
        error: { code: 'notifications.notice-not-found' },
      });
    });

    it('fails closed when the permission cannot be checked', async () => {
      deps = { ...deps, authorisation: { check: () => Promise.reject(new Error('down')) } };
      expect(await count(member(MEMBER_1, SELLER_A))).toEqual(ok({ unread: 0, newest: null }));
    });

    it('refuses an admin and a customer', async () => {
      for (const population of ['admin', 'customer'] as const) {
        const context = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population,
            accountId: MEMBER_1,
            sessionId: id<'Session'>(0x62),
            sellerId: null,
          }),
          'notice-other-0001',
        );
        expect(await list(context)).toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(await count(context)).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
    });

    it('counts unread notices and names the newest, for the order sound', async () => {
      const result = await count(member(MEMBER_1, SELLER_A));

      expect(result.ok && result.value.unread).toBe(2);
      expect(result.ok && result.value.newest?.createdAt).toBe('2026-10-17T10:05:00Z');
    });

    it('marks one notice read for that member only, and again changes nothing', async () => {
      const newest = notices.rows.filter((row) => row.sellerId === SELLER_A).at(-1)!.id;

      expect(await mark(member(MEMBER_1, SELLER_A), { id: newest })).toEqual(ok({ marked: 1 }));
      expect(await mark(member(MEMBER_1, SELLER_A), { id: newest })).toEqual(ok({ marked: 0 }));

      const mine = await list(member(MEMBER_1, SELLER_A), undefined, 'all');
      expect(mine.ok && mine.value.items.map((item) => item.read)).toEqual([true, false]);
      const unread = await list(member(MEMBER_1, SELLER_A));
      expect(unread.ok && unread.value.items.map((item) => item.read)).toEqual([false]);
      const read = await list(member(MEMBER_1, SELLER_A), undefined, 'read');
      expect(read.ok && read.value.items.map((item) => item.id)).toEqual([newest]);
      expect(await list(member(MEMBER_1, SELLER_A), undefined, 'archived')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'show', code: 'enum' }] },
      });
      const theirs = await count(member(MEMBER_2, SELLER_A));
      expect(theirs.ok && theirs.value.unread).toBe(2);
    });

    it('marks all read', async () => {
      expect(await mark(member(MEMBER_1, SELLER_A), { all: true })).toEqual(ok({ marked: 2 }));
      expect(await count(member(MEMBER_1, SELLER_A))).toEqual(ok({ unread: 0, newest: null }));
    });

    it("answers notice-not-found for another seller's notice and validation for a bad id", async () => {
      const theirs = notices.rows.find((row) => row.sellerId === SELLER_B)!.id;
      expect(await mark(member(MEMBER_1, SELLER_A), { id: theirs })).toEqual({
        ok: false,
        error: { code: 'notifications.notice-not-found' },
      });
      for (const bad of ['nope', 42, null]) {
        expect(await mark(member(MEMBER_1, SELLER_A), { id: bad })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'id', code: 'format' }] },
        });
      }
      expect(await list(member(MEMBER_1, SELLER_A), 'nope')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'before', code: 'format' }] },
      });
    });

    it('pages with the last id of the previous page', async () => {
      for (let n = 0; n < NOTICE_PAGE_SIZE; n += 1) await record();
      const first = await list(member(MEMBER_1, SELLER_A));
      expect(first.ok && first.value.items).toHaveLength(NOTICE_PAGE_SIZE);
      const next = first.ok ? first.value.next : null;
      expect(next).not.toBeNull();

      const second = await list(member(MEMBER_1, SELLER_A), next);
      expect(second.ok && second.value.items).toHaveLength(2);
      expect(second.ok && second.value.next).toBeNull();
    });
  });

  describe('retention', () => {
    it('hides and then purges notices older than 90 days, in this Market only', async () => {
      await record();
      clock.advance(Temporal.Duration.from({ hours: 90 * 24 + 1 }));
      await record();

      const visible = await count(member(MEMBER_1, SELLER_A));
      expect(visible.ok && visible.value.unread).toBe(1);

      await notices.addForSellers(other, [
        { id: id(0x9999), sellerId: SELLER_A, kind: SELLER_ORDER_PAID, params: {}, createdAt: T0 },
      ]);
      expect(await new PurgeExpiredNotices(gate, deps).execute(system, {})).toEqual(
        ok({ notices: 2 }),
      );
      expect(notices.rows.filter((row) => row.market === code)).toHaveLength(2);
      expect(notices.rows.filter((row) => row.market !== code)).toHaveLength(1);
    });
  });
});
