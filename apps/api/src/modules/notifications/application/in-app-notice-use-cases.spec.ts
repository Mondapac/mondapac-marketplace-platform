import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
import type { CatalogFacade } from '../../catalog';
import type { OrderingFacade, OrderNotice } from '../../ordering';
import {
  ADMIN_NOTICES_PER_MARKET,
  ADMIN_DELIVERY_FALLBACK_OVER_CAP,
  ADMIN_PRICE_HOLD_OPENED,
  ADMIN_PRODUCT_REVISION_SUBMITTED,
  ADMIN_SELLER_CERTIFICATE_SUBMITTED,
  ADMIN_SELLER_FILE_SUBMITTED,
  NOTICE_PAGE_SIZE,
  NOTICES_PER_SELLER,
  parseNoticeParams,
  SELLER_ACCESS_CHANGED,
  SELLER_CERTIFICATE_DECIDED,
  SELLER_IMAGE_TAKEN_DOWN,
  SELLER_LOW_STOCK,
  SELLER_OFFER_TAG_CHANGED,
  SELLER_ORDER_PAID,
  SELLER_PRICE_HOLD_DECIDED,
  type SellerOrderPaidParams,
} from '../domain/in-app-notice';
import type { InAppNoticeDependencies } from './in-app-notice-flow';
import type {
  InAppNoticeRepository,
  NewNotice,
  NoticeFilter,
  NoticeOwner,
  NoticeScope,
  StoredNotice,
} from './ports/in-app-notice.repository';
import { CountOwnUnreadNotices } from './use-cases/count-own-unread-notices.use-case';
import { ListOwnNotices } from './use-cases/list-own-notices.use-case';
import { MarkOwnNoticesRead } from './use-cases/mark-own-notices-read.use-case';
import { PurgeExpiredNotices } from './use-cases/purge-expired-notices.use-case';
import {
  RecordAdminReviewNotice,
  type AdminReviewItem,
} from './use-cases/record-admin-review-notice.use-case';
import {
  RecordSellerNotice,
  type SellerNoticeItem,
} from './use-cases/record-seller-notice.use-case';
import { RecordSellerOrderNotices } from './use-cases/record-seller-order-notices.use-case';

// The in-app notices in memory on both Market fixtures: a paid order becomes one "New order"
// notice per seller order, once; a seller-side member sees only their own seller's notices, only
// while they hold `ordering.seller-order.view`, and reads them for themselves only. Each review
// queue's event becomes one admin notice of the Market, shown to an admin only while they hold
// the queue's permission (package 3).

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
type MemoryRow = NewNotice & {
  readonly market: string;
  readonly audience: string;
  readonly sellerId: Id<'Seller'> | null;
};
const ownedBy = (row: MemoryRow, owner: NoticeOwner) =>
  row.audience === owner.audience &&
  row.sellerId === (owner.audience === 'seller' ? owner.sellerId : null);

class MemoryNotices implements InAppNoticeRepository {
  rows: MemoryRow[] = [];
  reads = new Set<string>();
  private inScope(market: MarketContext, scope: NoticeScope) {
    return this.rows
      .filter(
        (row) =>
          row.market === market.marketId &&
          ownedBy(row, scope.owner) &&
          scope.kinds.includes(row.kind) &&
          Temporal.Instant.compare(row.createdAt, scope.since) >= 0,
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }
  private stored(row: MemoryRow, accountId: string): StoredNotice {
    return {
      id: row.id,
      kind: row.kind,
      params: row.params,
      createdAt: row.createdAt,
      read: this.reads.has(`${row.id}|${accountId}`),
    };
  }
  add(market: MarketContext, notices: readonly NewNotice[]) {
    this.rows.push(
      ...notices.map((notice) => ({
        ...notice,
        market: market.marketId,
        audience: notice.owner.audience,
        sellerId: notice.owner.audience === 'seller' ? notice.owner.sellerId : null,
      })),
    );
    return Promise.resolve();
  }
  trim(market: MarketContext, owner: NoticeOwner, keep: number, kind?: string) {
    const mine = this.rows
      .filter(
        (row) =>
          row.market === market.marketId &&
          ownedBy(row, owner) &&
          (kind === undefined || row.kind === kind),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const gone = new Set(mine.slice(keep).map((row) => row.id));
    this.rows = this.rows.filter((row) => !gone.has(row.id));
    return Promise.resolve(gone.size);
  }
  list(
    market: MarketContext,
    scope: NoticeScope,
    page: { before: Id<'InAppNotice'> | null; limit: number; show: NoticeFilter },
  ) {
    const isRead = (row: MemoryRow) => this.reads.has(`${row.id}|${scope.accountId}`);
    return Promise.resolve(
      this.inScope(market, scope)
        .filter((row) => page.before === null || row.id < page.before)
        .filter((row) => page.show === 'all' || (page.show === 'read') === isRead(row))
        .slice(0, page.limit)
        .map((row) => this.stored(row, scope.accountId)),
    );
  }
  unread(market: MarketContext, scope: NoticeScope, newestOf: readonly string[]) {
    const unread = this.inScope(market, scope)
      .map((row) => this.stored(row, scope.accountId))
      .filter((row) => !row.read);
    const newest = unread.find((row) => newestOf.includes(row.kind)) ?? null;
    return Promise.resolve({ count: unread.length, newest });
  }
  exists(market: MarketContext, scope: NoticeScope, noticeId: Id<'InAppNotice'>) {
    return Promise.resolve(this.inScope(market, scope).some((row) => row.id === noticeId));
  }
  unreadIds(market: MarketContext, scope: NoticeScope, ids: readonly Id<'InAppNotice'>[] | 'all') {
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
    ['an inherited key as kind', 'constructor', {}],
    ['an admin notice without its id', ADMIN_SELLER_FILE_SUBMITTED, { fileKind: 'onboarding' }],
    [
      'an admin notice with an unknown enum',
      ADMIN_PRICE_HOLD_OPENED,
      { recordId: id(1), offerId: id(2), direction: 'sideways' },
    ],
    [
      'a delivery fallback notice without its order',
      ADMIN_DELIVERY_FALLBACK_OVER_CAP,
      { sellerId: id(1) },
    ],
  ])('refuses %s', (_label, kind, raw) => {
    expect(parseNoticeParams(kind, raw)).toBeNull();
  });
});

describe('parseNoticeParams of admin kinds', () => {
  it('keeps only the known ids and enums', () => {
    expect(
      parseNoticeParams(ADMIN_SELLER_CERTIFICATE_SUBMITTED, {
        sellerId: id(1) as string,
        sellerCertificationId: id(2) as string,
        submission: 'renewal',
        storeName: 'leaked',
      }),
    ).toEqual({ sellerId: id(1), sellerCertificationId: id(2), submission: 'renewal' });
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
  /** What ordering answers for the customer names; the asked ids are kept. */
  let customerNames: () => ReturnType<OrderingFacade['sellerOrderCustomerNames']>;
  let namesAsked: (readonly string[])[];
  /** The accounts that do NOT hold ordering.seller-order.view. */
  let withoutOrders: Set<string>;
  let checks: string[];
  /** What catalog answers for the pending revisions; the asked ids are kept. */
  let pendingRevisions: () => ReturnType<CatalogFacade['pendingProductRevisions']>;
  let revisionsAsked: (readonly { productId: string; revisionId: string }[])[];
  /** The permission keys each admin account holds (admins only). */
  let adminKeys: Map<string, readonly string[]>;
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
    customerNames = () => Promise.resolve(ok([]));
    namesAsked = [];
    withoutOrders = new Set();
    checks = [];
    pendingRevisions = () => Promise.resolve(ok(new Set([id<'ProductRevision'>(0x72)])));
    revisionsAsked = [];
    adminKeys = new Map();
    nextEvent = 1;
    const authorisation: AuthorisationCheck = {
      check: (context: CallContext, declaration: AccessDeclaration) => {
        checks.push(declaration.name);
        const actor = context.actor;
        if (actor.kind === 'authenticated' && actor.population === 'admin') {
          const held = adminKeys.get(actor.accountId) ?? [];
          const needed = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
          const allowedAdmin = needed.every((key) => held.includes(key));
          return Promise.resolve(
            allowedAdmin
              ? { allowed: true }
              : { allowed: false, denial: { code: 'access.denied' } },
          );
        }
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
      ordering: {
        orderNotice: () => orderNotice,
        sellerOrderCustomerNames: (_context: CallContext, ids: readonly string[]) => {
          namesAsked.push(ids);
          return customerNames();
        },
      } as unknown as OrderingFacade,
      catalog: {
        pendingProductRevisions: (
          _context: CallContext,
          refs: readonly { productId: string; revisionId: string }[],
        ) => {
          revisionsAsked.push(refs);
          return pendingRevisions();
        },
      } as unknown as CatalogFacade,
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
      // One check per permission behind the seller kinds, never one per kind.
      expect(checks).toEqual([
        'notifications.see-seller-order-notices',
        'notifications.see-seller-stock-notices',
        'notifications.see-seller-certificate-notices',
        'notifications.see-seller-catalog-notices',
        'notifications.see-seller-price-notices',
        'notifications.see-seller-access-notices',
      ]);
      // No customer data reaches the notice.
      expect(JSON.stringify(result)).not.toContain(NOTICE.accountId);
    });

    it("adds the customer's short name at read time, with one ordering call per page", async () => {
      customerNames = () =>
        Promise.resolve(
          ok([{ sellerOrderId: id<'SellerOrder'>(0x21), customerShortName: 'Maryam R.' }]),
        );

      const result = await list(member(MEMBER_1, SELLER_A));

      expect(result.ok && result.value.items.map((item) => item.customerShortName)).toEqual([
        'Maryam R.',
        'Maryam R.',
      ]);
      expect(namesAsked).toEqual([[id(0x21)]]);
      // Nothing about the customer is written back to the notice.
      expect(JSON.stringify(notices.rows)).not.toContain('Maryam');
    });

    it('shows no name, and still lists, when ordering refuses or fails', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      for (const answer of [
        () => Promise.resolve(err({ code: 'access.denied' as const })),
        () => Promise.reject(new Error('down')),
      ]) {
        customerNames = answer;
        const result = await list(member(MEMBER_1, SELLER_A));
        expect(result.ok && result.value.items.map((item) => item.customerShortName)).toEqual([
          null,
          null,
        ]);
      }
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'notifications.customer-names-refused' }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'notifications.customer-names-failed' }),
      );
      error.mockRestore();
      warn.mockRestore();
    });

    it('asks ordering nothing for an empty page', async () => {
      withoutOrders.add(MEMBER_1);
      expect(await list(member(MEMBER_1, SELLER_A))).toEqual(ok({ items: [], next: null }));
      expect(namesAsked).toEqual([]);
    });

    it('never shows another seller, or the same seller in another Market', async () => {
      const b = await list(member(MEMBER_B, SELLER_B));
      expect(
        b.ok &&
          b.value.items.every(
            (item) => (item.params as SellerOrderPaidParams).sellerOrderId === id(0x22),
          ),
      ).toBe(true);

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

    it('shows an admin no seller notice, and refuses a customer', async () => {
      const admin = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: MEMBER_1,
          sessionId: id<'Session'>(0x62),
          sellerId: null,
        }),
        'notice-admin-0001',
      );
      expect(await list(admin)).toEqual(ok({ items: [], next: null }));
      expect(await count(admin)).toEqual(ok({ unread: 0, newest: null }));
      for (const population of ['customer'] as const) {
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

      await notices.add(other, [
        {
          id: id(0x9999),
          owner: { audience: 'seller', sellerId: SELLER_A },
          kind: SELLER_ORDER_PAID,
          params: {},
          createdAt: T0,
        },
      ]);
      expect(await new PurgeExpiredNotices(gate, deps).execute(system, {})).toEqual(
        ok({ notices: 2 }),
      );
      expect(notices.rows.filter((row) => row.market === code)).toHaveLength(2);
      expect(notices.rows.filter((row) => row.market !== code)).toHaveLength(1);
    });
  });
  describe('admin review notices (package 3)', () => {
    const ADMIN_ALL = id<'Account'>(0xd1);
    const ADMIN_PRICES = id<'Account'>(0xd2);
    const ADMIN_NONE = id<'Account'>(0xd3);
    const admin = (accountId: Id<'Account'>, on = market) =>
      testCallContext(
        on,
        testAuthenticatedActor(on, {
          population: 'admin',
          accountId,
          sessionId: id<'Session'>(0x63),
          sellerId: null,
        }),
        'notice-admin-0002',
      );
    const ITEMS: Readonly<Record<string, AdminReviewItem>> = {
      certificate: {
        kind: ADMIN_SELLER_CERTIFICATE_SUBMITTED,
        sellerId: SELLER_A,
        sellerCertificationId: id(0x71),
        submission: 'initial',
      },
      revision: {
        kind: ADMIN_PRODUCT_REVISION_SUBMITTED,
        productId: id(0x73),
        revisionId: id(0x72),
        scope: 'seller',
      },
      sellerFile: { kind: ADMIN_SELLER_FILE_SUBMITTED, sellerId: SELLER_B, fileKind: 'onboarding' },
      priceHold: {
        kind: ADMIN_PRICE_HOLD_OPENED,
        recordId: id(0x74),
        offerId: id(0x31),
        direction: 'up',
      },
      deliveryFallback: {
        kind: ADMIN_DELIVERY_FALLBACK_OVER_CAP,
        sellerOrderId: id(0x75),
        sellerId: SELLER_A,
      },
    };
    const review = (item: AdminReviewItem, eventNo = nextEvent++) =>
      new RecordAdminReviewNotice(gate, deps).execute(system, {
        delivery: delivery(eventNo),
        item,
      });

    beforeEach(() => {
      adminKeys.set(ADMIN_ALL, [
        'certification.seller-certificate.review',
        'catalog.product.approve',
        'sellers.seller-file.review',
        'pricing.price-hold.decide',
        'shipping.delivery-settings.view',
      ]);
      adminKeys.set(ADMIN_PRICES, ['pricing.price-hold.decide']);
    });

    it('writes one Market notice per waiting item, with ids and enums only', async () => {
      for (const item of Object.values(ITEMS)) {
        expect(await review(item)).toEqual(ok({ code: 'notices.recorded', notices: 1 }));
      }
      expect(
        notices.rows.map(({ audience, sellerId, kind, params, market: m }) => ({
          audience,
          sellerId,
          kind,
          params,
          m,
        })),
      ).toEqual([
        {
          audience: 'admin',
          sellerId: null,
          kind: ADMIN_SELLER_CERTIFICATE_SUBMITTED,
          params: { sellerId: SELLER_A, sellerCertificationId: id(0x71), submission: 'initial' },
          m: code,
        },
        {
          audience: 'admin',
          sellerId: null,
          kind: ADMIN_PRODUCT_REVISION_SUBMITTED,
          params: { productId: id(0x73), revisionId: id(0x72) },
          m: code,
        },
        {
          audience: 'admin',
          sellerId: null,
          kind: ADMIN_SELLER_FILE_SUBMITTED,
          params: { sellerId: SELLER_B, fileKind: 'onboarding' },
          m: code,
        },
        {
          audience: 'admin',
          sellerId: null,
          kind: ADMIN_PRICE_HOLD_OPENED,
          params: { recordId: id(0x74), offerId: id(0x31), direction: 'up' },
          m: code,
        },
        {
          audience: 'admin',
          sellerId: null,
          kind: ADMIN_DELIVERY_FALLBACK_OVER_CAP,
          params: { sellerOrderId: id(0x75), sellerId: SELLER_A },
          m: code,
        },
      ]);
      expect(revisionsAsked).toEqual([[{ productId: id(0x73), revisionId: id(0x72) }]]);
    });

    it('adds nothing for a repeated delivery', async () => {
      await review(ITEMS.priceHold!, 9);
      expect(await review(ITEMS.priceHold!, 9)).toEqual(ok({ code: 'notices.already-handled' }));
      expect(notices.rows).toHaveLength(1);
    });

    it('skips a revision that published at once, and a platform revision', async () => {
      pendingRevisions = () => Promise.resolve(ok(new Set()));
      expect(await review(ITEMS.revision!)).toEqual(
        ok({ code: 'notices.skipped', reason: 'revision.not-pending' }),
      );
      const platform = { ...ITEMS.revision!, scope: 'platform' } as AdminReviewItem;
      expect(await review(platform)).toEqual(
        ok({ code: 'notices.skipped', reason: 'revision.not-pending' }),
      );
      expect(revisionsAsked).toHaveLength(1);
      expect(notices.rows).toEqual([]);
      expect(unitOfWork.handled.size).toBe(2);
    });

    it('throws a catalog fault back to the delivery and marks nothing', async () => {
      pendingRevisions = () => Promise.resolve(err({ code: 'batch.too-large' as const }));
      await expect(review(ITEMS.revision!)).rejects.toThrow('the revision could not be read');
      expect(unitOfWork.handled.size).toBe(0);
    });

    it(`keeps the newest ${ADMIN_NOTICES_PER_MARKET} admin notices of each kind`, async () => {
      await review(ITEMS.certificate!);
      for (let n = 0; n <= ADMIN_NOTICES_PER_MARKET; n += 1) await review(ITEMS.priceHold!);
      expect(notices.rows.filter((row) => row.kind === ADMIN_PRICE_HOLD_OPENED)).toHaveLength(
        ADMIN_NOTICES_PER_MARKET,
      );
      // A flood of one queue never pushes another queue's notice out.
      expect(notices.rows.some((row) => row.kind === ADMIN_SELLER_CERTIFICATE_SUBMITTED)).toBe(
        true,
      );
    });

    it('is system-only', async () => {
      await expectSystemOnly(code, (context) =>
        new RecordAdminReviewNotice(gate, deps).execute(context, {
          delivery: delivery(1),
          item: ITEMS.priceHold!,
        }),
      );
    });

    describe('reading', () => {
      beforeEach(async () => {
        for (const item of Object.values(ITEMS)) await review(item);
        await record();
      });

      it('shows an admin each kind only while they hold its permission', async () => {
        const all = await list(admin(ADMIN_ALL));
        expect(all.ok && all.value.items.map((item) => item.kind)).toEqual([
          ADMIN_DELIVERY_FALLBACK_OVER_CAP,
          ADMIN_PRICE_HOLD_OPENED,
          ADMIN_SELLER_FILE_SUBMITTED,
          ADMIN_PRODUCT_REVISION_SUBMITTED,
          ADMIN_SELLER_CERTIFICATE_SUBMITTED,
        ]);
        expect(all.ok && all.value.items.every((item) => item.customerShortName === null)).toBe(
          true,
        );
        expect(namesAsked).toEqual([]);

        const prices = await list(admin(ADMIN_PRICES));
        expect(prices.ok && prices.value.items.map((item) => item.kind)).toEqual([
          ADMIN_PRICE_HOLD_OPENED,
        ]);
        expect(await count(admin(ADMIN_NONE))).toEqual(ok({ unread: 0, newest: null }));

        adminKeys.set(ADMIN_PRICES, []);
        expect(await list(admin(ADMIN_PRICES))).toEqual(ok({ items: [], next: null }));
      });

      it('never shows admin notices to a seller member, nor in another Market', async () => {
        const seller = await list(member(MEMBER_1, SELLER_A), undefined, 'all');
        expect(
          seller.ok && seller.value.items.every((item) => item.kind === SELLER_ORDER_PAID),
        ).toBe(true);
        expect(await list(admin(ADMIN_ALL, other))).toEqual(ok({ items: [], next: null }));
      });

      it('reads per admin: one admin marking all leaves the others unread', async () => {
        expect(await mark(admin(ADMIN_PRICES), { all: true })).toEqual(ok({ marked: 1 }));
        const all = await count(admin(ADMIN_ALL));
        expect(all.ok && all.value.unread).toBe(5);
        expect(all.ok && all.value.newest?.kind).toBe(ADMIN_DELIVERY_FALLBACK_OVER_CAP);

        const certificate = notices.rows.find(
          (row) => row.kind === ADMIN_SELLER_CERTIFICATE_SUBMITTED,
        )!.id;
        expect(await mark(admin(ADMIN_PRICES), { id: certificate })).toEqual({
          ok: false,
          error: { code: 'notifications.notice-not-found' },
        });
        expect(await mark(admin(ADMIN_ALL), { id: certificate })).toEqual(ok({ marked: 1 }));
      });
    });
  });
});

describe('parseNoticeParams of seller kinds (package 4)', () => {
  it('keeps the known ids, enums and counts only', () => {
    expect(
      parseNoticeParams(SELLER_LOW_STOCK, {
        offerId: id(1) as string,
        variantId: id(2) as string,
        onlyLeft: 3,
        productName: 'leaked',
      }),
    ).toEqual({ offerId: id(1), variantId: id(2), onlyLeft: 3 });
    expect(parseNoticeParams(SELLER_ACCESS_CHANGED, { change: 'reinstated' })).toEqual({
      change: 'reinstated',
    });
  });

  it.each([
    ['a negative count', SELLER_LOW_STOCK, { offerId: id(1), variantId: id(2), onlyLeft: -1 }],
    ['a count as text', SELLER_LOW_STOCK, { offerId: id(1), variantId: id(2), onlyLeft: '3' }],
    [
      'an unknown outcome',
      SELLER_CERTIFICATE_DECIDED,
      { sellerCertificationId: id(1), outcome: 'x' },
    ],
    ['a missing id', SELLER_IMAGE_TAKEN_DOWN, { productId: id(1), reason: 'rights' }],
    [
      'a superseded hold',
      SELLER_PRICE_HOLD_DECIDED,
      {
        offerId: id(1),
        variantId: id(2),
        recordId: id(3),
        outcome: 'superseded',
        priceKind: 'regular',
      },
    ],
  ])('refuses %s', (_label, kind, raw) => {
    expect(parseNoticeParams(kind, raw)).toBeNull();
  });
});

describe.each([['AU'], ['ZZ']] as const)('seller notices (package 4) in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system', 'notice-sys-0004');
  const OFFER = id<'Offer'>(0x31);
  const PRODUCT = id<'Product'>(0x71);
  const OWNER = id<'Account'>(0xa0);

  let notices: MemoryNotices;
  let unitOfWork: FakeUnitOfWork;
  let offerOwners: Map<string, Id<'Seller'>>;
  let productOwners: Map<string, Id<'Seller'>>;
  let catalogAnswer: 'ok' | 'denied' | 'fault';
  /** The permission keys each seller-side account holds. */
  let keys: Map<string, readonly string[]>;
  let deps: InAppNoticeDependencies;
  let nextEvent: number;

  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const member = (accountId: Id<'Account'>, sellerId: Id<'Seller'> = SELLER_A) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      'notice-member-0004',
    );
  const record = (item: SellerNoticeItem, eventNo = nextEvent++) =>
    new RecordSellerNotice(gate, deps).execute(system, {
      delivery: {
        eventId: id<'event'>(0xf00 + eventNo),
        subscriber: 'notifications.seller-low-stock-notice',
        attempt: 1,
      },
      item,
    });
  const lowStock = (sellerId: string = SELLER_A): SellerNoticeItem => ({
    kind: SELLER_LOW_STOCK,
    owner: { by: 'seller', sellerId },
    params: { offerId: OFFER, variantId: id(0x41), onlyLeft: 2 },
  });
  const tagSuspended: SellerNoticeItem = {
    kind: SELLER_OFFER_TAG_CHANGED,
    owner: { by: 'offer', offerId: OFFER },
    params: { offerId: OFFER, tagId: id(0x51), change: 'suspended' },
  };
  const imageDown: SellerNoticeItem = {
    kind: SELLER_IMAGE_TAKEN_DOWN,
    owner: { by: 'product', productId: PRODUCT },
    params: { productId: PRODUCT, imageId: id(0x52), reason: 'rights' },
  };
  const list = (context: CallContext) =>
    new ListOwnNotices(gate, deps).execute(context, { show: 'all' });
  const count = (context: CallContext) =>
    new CountOwnUnreadNotices(gate, deps).execute(context, {});
  const kindsSeenBy = async (context: CallContext) => {
    const result = await list(context);
    return result.ok ? result.value.items.map((item) => item.kind) : result;
  };

  beforeEach(() => {
    notices = new MemoryNotices();
    unitOfWork = new FakeUnitOfWork();
    offerOwners = new Map([[OFFER, SELLER_A]]);
    productOwners = new Map([[PRODUCT, SELLER_A]]);
    catalogAnswer = 'ok';
    keys = new Map();
    nextEvent = 1;
    const answer = <T>(value: T) => {
      if (catalogAnswer === 'denied') return Promise.resolve(err({ code: 'access.denied' }));
      if (catalogAnswer === 'fault') return Promise.resolve(err({ code: 'batch.too-large' }));
      return Promise.resolve(ok(value));
    };
    const authorisation: AuthorisationCheck = {
      check: (context: CallContext, declaration: AccessDeclaration) => {
        const actor = context.actor;
        const held = actor.kind === 'authenticated' ? (keys.get(actor.accountId) ?? []) : [];
        const needed = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needed.length > 0 && needed.every((key) => held.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    deps = {
      unitOfWork,
      notices,
      ordering: {
        sellerOrderCustomerNames: () => Promise.resolve(ok([])),
      } as unknown as OrderingFacade,
      catalog: {
        offerSellUnits: (_context: CallContext, ids: readonly string[]) =>
          answer(
            new Map(
              ids
                .filter((offerId) => offerOwners.has(offerId))
                .map((offerId) => [offerId, { sellerId: offerOwners.get(offerId) }]),
            ),
          ),
        sellerProductOwners: (_context: CallContext, ids: readonly string[]) =>
          answer(
            new Map(
              ids
                .filter((productId) => productOwners.has(productId))
                .map((productId) => [productId, productOwners.get(productId)]),
            ),
          ),
      } as unknown as CatalogFacade,
      authorisation,
      ids: new CountingIds(),
      clock: new FixedClock(T0),
    };
  });

  describe('recording', () => {
    it("writes one notice for the event's seller, once per delivery", async () => {
      expect(await record(lowStock(), 9)).toEqual(ok({ code: 'notices.recorded', notices: 1 }));
      expect(await record(lowStock(), 9)).toEqual(ok({ code: 'notices.already-handled' }));
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
          kind: SELLER_LOW_STOCK,
          params: { offerId: OFFER, variantId: id(0x41), onlyLeft: 2 },
          m: code,
        },
      ]);
    });

    it("reads an Offer's or a product's owner through catalog", async () => {
      offerOwners.set(OFFER, SELLER_B);
      expect(await record(tagSuspended)).toEqual(ok({ code: 'notices.recorded', notices: 1 }));
      expect(await record(imageDown)).toEqual(ok({ code: 'notices.recorded', notices: 1 }));
      expect(notices.rows.map((row) => [row.kind, row.sellerId])).toEqual([
        [SELLER_OFFER_TAG_CHANGED, SELLER_B],
        [SELLER_IMAGE_TAKEN_DOWN, SELLER_A],
      ]);
    });

    it('marks the delivery and writes nothing when catalog knows no seller owner', async () => {
      offerOwners.clear();
      productOwners.clear();
      expect(await record(tagSuspended)).toEqual(
        ok({ code: 'notices.skipped', reason: 'owner.unknown' }),
      );
      expect(await record(imageDown)).toEqual(
        ok({ code: 'notices.skipped', reason: 'owner.unknown' }),
      );
      expect(notices.rows).toEqual([]);
      expect(unitOfWork.handled.size).toBe(2);
    });

    it('passes a refusal on, and throws a read fault back to the delivery', async () => {
      catalogAnswer = 'denied';
      expect(await record(tagSuspended)).toEqual({ ok: false, error: { code: 'access.denied' } });
      catalogAnswer = 'fault';
      await expect(record(imageDown)).rejects.toThrow('the owner could not be read');
      expect(unitOfWork.handled.size).toBe(0);
    });

    it('refuses params that do not fit the kind', async () => {
      await expect(
        record({ ...lowStock(), params: { offerId: OFFER, name: 'leaked' } }),
      ).rejects.toThrow('the params do not fit');
      expect(notices.rows).toEqual([]);
    });

    it(`caps each kind at ${NOTICES_PER_SELLER}, so a flood of low stock keeps the orders`, async () => {
      notices.rows.push({
        id: id<'InAppNotice'>(0x10),
        owner: { audience: 'seller', sellerId: SELLER_A },
        kind: SELLER_ORDER_PAID,
        params: { sellerOrderId: id(0x21), items: 1 },
        createdAt: T0,
        market: code,
        audience: 'seller',
        sellerId: SELLER_A,
      });
      for (let n = 0; n <= NOTICES_PER_SELLER; n += 1) await record(lowStock());
      expect(notices.rows.filter((row) => row.kind === SELLER_LOW_STOCK)).toHaveLength(
        NOTICES_PER_SELLER,
      );
      expect(notices.rows.filter((row) => row.kind === SELLER_ORDER_PAID)).toHaveLength(1);
    });

    it('is system-only', async () => {
      await expectSystemOnly(code, (context) =>
        new RecordSellerNotice(gate, deps).execute(context, {
          delivery: { eventId: id<'event'>(1), subscriber: 's', attempt: 1 },
          item: lowStock(),
        }),
      );
    });
  });

  describe('reading', () => {
    beforeEach(async () => {
      await record(lowStock());
      await record(tagSuspended);
      await record({
        kind: SELLER_CERTIFICATE_DECIDED,
        owner: { by: 'seller', sellerId: SELLER_A },
        params: { sellerCertificationId: id(0x61), outcome: 'approved' },
      });
      await record({
        kind: SELLER_PRICE_HOLD_DECIDED,
        owner: { by: 'offer', offerId: OFFER },
        params: {
          offerId: OFFER,
          variantId: id(0x41),
          recordId: id(0x62),
          outcome: 'rejected',
          priceKind: 'regular',
        },
      });
      await record({
        kind: SELLER_ACCESS_CHANGED,
        owner: { by: 'seller', sellerId: SELLER_A },
        params: { change: 'approved' },
      });
      await record(lowStock(SELLER_B));
    });

    it('shows each member only the kinds whose permission they hold, of their own seller', async () => {
      keys.set(MEMBER_1, ['catalog.own-product.view', 'certification.own-certificate.view']);
      keys.set(MEMBER_2, ['inventory.stock.view', 'pricing.price.view']);
      keys.set(OWNER, [
        'inventory.stock.view',
        'catalog.own-product.view',
        'certification.own-certificate.view',
        'pricing.price.view',
        'identity.team-member.invite',
      ]);
      expect(await kindsSeenBy(member(MEMBER_1))).toEqual([
        SELLER_CERTIFICATE_DECIDED,
        SELLER_OFFER_TAG_CHANGED,
      ]);
      expect(await kindsSeenBy(member(MEMBER_2))).toEqual([
        SELLER_PRICE_HOLD_DECIDED,
        SELLER_LOW_STOCK,
      ]);
      expect(await kindsSeenBy(member(OWNER))).toEqual([
        SELLER_ACCESS_CHANGED,
        SELLER_PRICE_HOLD_DECIDED,
        SELLER_CERTIFICATE_DECIDED,
        SELLER_OFFER_TAG_CHANGED,
        SELLER_LOW_STOCK,
      ]);
      expect(await kindsSeenBy(member(MEMBER_B, SELLER_B))).toEqual([]);
    });

    it('carries the newest unread order for the sound, never a newer notice of another kind', async () => {
      keys.set(OWNER, ['ordering.seller-order.view', 'inventory.stock.view']);
      const before = await count(member(OWNER));
      expect(before).toEqual(ok({ unread: 1, newest: null }));
      notices.rows.unshift({
        id: id<'InAppNotice'>(0x10),
        owner: { audience: 'seller', sellerId: SELLER_A },
        kind: SELLER_ORDER_PAID,
        params: { sellerOrderId: id(0x21), items: 1 },
        createdAt: T0,
        market: code,
        audience: 'seller',
        sellerId: SELLER_A,
      });
      await record(lowStock());
      const after = await count(member(OWNER));
      expect(after.ok && after.value.unread).toBe(3);
      expect(after.ok && after.value.newest?.kind).toBe(SELLER_ORDER_PAID);
    });
  });
});
