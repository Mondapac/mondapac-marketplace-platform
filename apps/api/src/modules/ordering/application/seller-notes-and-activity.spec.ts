import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeAdminNoteCipher,
  FakeLabels,
  MemoryOrders,
  MemorySellerNotes,
  NO_REFUNDS,
} from '../../../../test/support/ordering-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  ORDERING_ORDER_VIEW,
  ORDERING_SELLER_ORDER_NOTE,
  ORDERING_SELLER_ORDER_VIEW,
} from '../contracts/permissions';
import type { OrderState, SellerOrder } from '../domain/order';
import type { Refund } from '../domain/refund';
import type { OrderingDependencies } from './checkout-flow';
import type { RefundRepository } from './ports/refund.repository';
import { sellerActivity } from './activity-flow';
import { addSellerNote, listSellerNotes, type SellerNoteDependencies } from './seller-note-flow';
import { AdminViewOrderActivity } from './use-cases/admin-view-order-activity.use-case';
import { SellerAddOrderNote } from './use-cases/seller-add-order-note.use-case';
import { SellerListOrderNotes } from './use-cases/seller-list-order-notes.use-case';
import { SellerViewOrderActivity } from './use-cases/seller-view-order-activity.use-case';

// Seller notes on a seller order and the order activity timeline in memory, on both Market
// fixtures: the declared keys, the ownership check (another shop's seller order is unknown), the
// acting-as rule (reads only), the text rules, the sealed storage, the audit row without text,
// and the timeline each role may see.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-12T03:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const MEMBER = id<'Account'>(0xa1);
const OTHER_MEMBER = id<'Account'>(0xa2);
const ADMIN = id<'Account'>(0xad);
const SELLER_A = id<'Seller'>(0x5a);
const SELLER_B = id<'Seller'>(0x5b);
const ORDER = id<'Order'>(0x01);
const SO_A = id<'SellerOrder'>(0x0a);
const SO_B = id<'SellerOrder'>(0x0b);
const VIEW = ORDERING_SELLER_ORDER_VIEW.key;
const NOTE = ORDERING_SELLER_ORDER_NOTE.key;

describe.each([['AU'], ['ZZ']] as const)('seller notes and order activity in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  const held = new Map<string, readonly string[]>();
  const gate = createUseCaseGate(markets, {
    check: (context, declaration): Promise<AccessDecision> => {
      const actor = context.actor;
      const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
      const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
      return Promise.resolve(
        needs.every((key) => keys.includes(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  });
  const sellerOf = (accountId: Id<'Account'>, sellerId: Id<'Seller'>, keys: readonly string[]) => {
    held.set(accountId, keys);
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: id<'Session'>(0x600),
        sellerId,
      }),
      'seller-notes-0001',
    );
  };
  const actingAs = (context: CallContext) =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: ADMIN, sellerId: SELLER_A } },
    }) as unknown as CallContext;
  const admin = () => {
    held.set(ADMIN, [ORDERING_ORDER_VIEW.key]);
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x601),
        sellerId: null,
      }),
      'seller-notes-0002',
    );
  };

  let notes: MemorySellerNotes;
  let cipher: FakeAdminNoteCipher;
  let labels: FakeLabels;
  let audits: AuditEntry[];
  let deps: SellerNoteDependencies;
  beforeEach(() => {
    held.clear();
    notes = new MemorySellerNotes();
    notes.sellerOrders.set(SO_A, { orderId: ORDER, sellerId: SELLER_A, accountId: CUSTOMER });
    notes.sellerOrders.set(SO_B, { orderId: ORDER, sellerId: SELLER_B, accountId: CUSTOMER });
    cipher = new FakeAdminNoteCipher();
    labels = new FakeLabels();
    audits = [];
    const audit: AuditWriter = {
      record: (_c, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      notes,
      cipher,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
      labels,
    };
  });
  const add = (context: CallContext, body: unknown, sellerOrderId: unknown = SO_A) =>
    new SellerAddOrderNote(gate, deps).execute(context, { sellerOrderId, body });
  const list = (context: CallContext, sellerOrderId: unknown = SO_A) =>
    new SellerListOrderNotes(gate, deps).execute(context, { sellerOrderId });

  describe('seller notes', () => {
    it('declares the view key to read and the view and note keys to write', () => {
      expect(SellerListOrderNotes.access).toEqual({
        name: 'ordering.seller-list-order-notes',
        rule: { kind: 'permissions', allOf: [VIEW] },
        whenSellerNotApproved: 'deny',
      });
      expect(SellerAddOrderNote.access).toEqual({
        name: 'ordering.seller-add-order-note',
        rule: { kind: 'permissions', allOf: [VIEW, NOTE] },
        whenSellerNotApproved: 'deny',
      });
      expect(ORDERING_SELLER_ORDER_NOTE).toMatchObject({ scope: 'seller', protected: false });
    });

    it('stores the text sealed, answers it newest first to the shop, and audits id and length only', async () => {
      const writer = sellerOf(MEMBER, SELLER_A, [VIEW, NOTE]);
      labels.staff.set(MEMBER, 'Sara');

      const first = await add(writer, '  Customer asked for\r\nextra ice  ');
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const second = await add(writer, 'Packed');
      clock.set(T0);

      if (!first.ok || !second.ok) throw new Error('note');
      expect(first.value).toMatchObject({
        body: 'Customer asked for\nextra ice',
        authorAccountId: MEMBER,
        authorName: 'Sara',
        byYou: true,
        createdAt: T0,
      });
      expect(notes.rows).toHaveLength(2);
      expect(notes.rows[0]).toMatchObject({
        orderId: ORDER,
        sellerOrderId: SO_A,
        sellerId: SELLER_A,
      });
      expect(notes.rows[0]!.bodySealed).not.toContain('ice');
      expect(audits.map((a) => [a.action, a.targetId, a.after])).toEqual([
        ['ordering.seller-order.note-added', SO_A, { noteId: first.value.noteId, length: 28 }],
        ['ordering.seller-order.note-added', SO_A, { noteId: second.value.noteId, length: 6 }],
      ]);

      const reader = sellerOf(OTHER_MEMBER, SELLER_A, [VIEW]);
      const listed = await list(reader);
      expect(listed.ok && listed.value.map((n) => [n.body, n.byYou])).toEqual([
        ['Packed', false],
        ['Customer asked for\nextra ice', false],
      ]);
    });

    it("answers another shop's seller order exactly as an unknown one, and lists none of its notes", async () => {
      const otherShop = sellerOf(OTHER_MEMBER, SELLER_B, [VIEW, NOTE]);
      expect((await add(otherShop, 'Mine', SO_B)).ok).toBe(true);
      const mine = sellerOf(MEMBER, SELLER_A, [VIEW, NOTE]);

      for (const target of [SO_B, id<'SellerOrder'>(0xee)]) {
        expect(await add(mine, 'Hello', target)).toEqual({
          ok: false,
          error: { code: 'ordering.seller-order-not-found' },
        });
        expect(await list(mine, target)).toEqual({
          ok: false,
          error: { code: 'ordering.seller-order-not-found' },
        });
      }
      expect(await list(mine)).toEqual({ ok: true, value: [] });
    });

    it('refuses a member without the note key, and anyone without the view key', async () => {
      expect(await add(sellerOf(MEMBER, SELLER_A, [VIEW]), 'Hi')).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await list(sellerOf(MEMBER, SELLER_A, [NOTE]))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await add(sellerOf(MEMBER, SELLER_A, [NOTE]), 'Hi')).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(notes.rows).toHaveLength(0);
    });

    // No session carries the acting-as marker yet (SEL-08), and the gate refuses a context it did
    // not mint, so the rule is proven on the flow behind the gate.
    it('lets an acting-as session read the notes but never write one', async () => {
      const writer = sellerOf(MEMBER, SELLER_A, [VIEW, NOTE]);
      expect((await add(writer, 'Kept')).ok).toBe(true);

      expect(
        await addSellerNote(deps, actingAs(writer), {
          sellerOrderId: SO_A,
          body: 'From the admin',
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      const read = await listSellerNotes(deps, actingAs(writer), { sellerOrderId: SO_A });
      expect(read.ok && read.value.map((n) => n.body)).toEqual(['Kept']);
      expect(notes.rows).toHaveLength(1);
    });

    it('refuses an admin, a customer and the system: the notes are the shop’s alone', async () => {
      held.set(ADMIN, [VIEW, NOTE]);
      const adminContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ADMIN,
          sessionId: id<'Session'>(0x602),
          sellerId: null,
        }),
      );
      held.set(CUSTOMER, [VIEW, NOTE]);
      const customer = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'customer',
          accountId: CUSTOMER,
          sessionId: id<'Session'>(0x603),
          sellerId: null,
        }),
      );
      for (const who of [adminContext, customer]) {
        expect(await list(who)).toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(await add(who, 'x')).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
      expect((await list(testCallContext(market, 'system'))).ok).toBe(false);
    });

    it('validates the id and the text: empty, too long, hidden characters, not a string', async () => {
      const writer = sellerOf(MEMBER, SELLER_A, [VIEW, NOTE]);
      for (const [body, code] of [
        ['   ', 'required'],
        ['x'.repeat(2001), 'too-long'],
        ['a‮b', 'format'],
        ['a\u0007b', 'format'],
        [42, 'type'],
      ] as const) {
        expect(await add(writer, body)).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'body', code }] },
        });
      }
      expect(await add(writer, 'ok', 'nope')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] },
      });
      expect(await list(writer, 'nope')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] },
      });
      expect((await add(writer, 'x'.repeat(2000))).ok).toBe(true);
      expect((await add(writer, 'نی‌از')).ok).toBe(true);
    });

    it('shows a note without text once the customer was erased, and writes no new one', async () => {
      const writer = sellerOf(MEMBER, SELLER_A, [VIEW, NOTE]);
      expect((await add(writer, 'Called')).ok).toBe(true);
      cipher.destroyed.add(CUSTOMER);

      const read = await list(writer);
      expect(read.ok && read.value.map((n) => n.body)).toEqual([null]);
      expect(await add(writer, 'Again')).toEqual({
        ok: false,
        error: { code: 'ordering.customer-erased' },
      });
    });

    it('still answers the notes when the author names cannot be read', async () => {
      const writer = sellerOf(MEMBER, SELLER_A, [VIEW, NOTE]);
      expect((await add(writer, 'Hi')).ok).toBe(true);
      labels.fail.add('staff');
      const read = await list(writer);
      expect(read.ok && read.value.map((n) => [n.body, n.authorName])).toEqual([['Hi', null]]);
    });
  });

  describe('order activity', () => {
    const sellerOrder = (
      sellerOrderId: Id<'SellerOrder'>,
      sellerId: Id<'Seller'>,
      patch: Partial<SellerOrder> = {},
    ): SellerOrder => ({
      id: sellerOrderId,
      sellerId,
      subtotal: 3000n,
      shipping: 500n,
      shippingTaxRateBps: null,
      shippingTax: null,
      shippingTaxInclusive: null,
      total: 3500n,
      fulfilment: 'to-ship',
      carrier: null,
      trackingRef: null,
      shippedAt: null,
      deliveredAt: null,
      inventoryRecordedAt: null,
      ledgerState: 'pending',
      deliveryMethod: 'instant',
      deliveryWindow: null,
      readyAt: null,
      readyPrepMinutes: null,
      deliveryAttention: null,
      deliveryQuote: null,
      ...patch,
    });
    const paid: OrderState = {
      id: ORDER,
      marketId: market.marketId,
      accountId: CUSTOMER,
      status: 'confirmed',
      cancelReason: null,
      paymentState: 'captured',
      total: money(7000n, currency),
      reservationId: 'r',
      stripeIdempotencyKey: 'k',
      stripeSessionId: null,
      stripePaymentIntentId: null,
      paymentExpiresAt: T0.add({ minutes: 30 }),
      createdAt: T0,
      confirmedAt: T0.add({ minutes: 1 }),
      cancelledAt: null,
      version: 2,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: [
        sellerOrder(SO_A, SELLER_A, { readyAt: T0.add({ minutes: 5 }) }),
        sellerOrder(SO_B, SELLER_B, { readyAt: T0.add({ minutes: 7 }) }),
      ],
      lines: [],
    };
    const refundOf = (
      n: number,
      sellerOrderId: Id<'SellerOrder'>,
      sellerId: Id<'Seller'>,
    ): Refund => ({
      id: id<'Refund'>(n),
      orderId: ORDER,
      sellerOrderId,
      sellerId,
      currency,
      gross: 1000n,
      tax: 0n,
      shipping: null,
      reason: 'item-unavailable',
      lossBearer: 'seller',
      lossReasonCode: null,
      actor: { population: 'seller', accountId: MEMBER },
      state: 'pending',
      stripeIdempotencyKey: `r-${n}`,
      stripeRefundId: null,
      attempts: 0,
      requestedAt: T0.add({ minutes: 3 }),
      settledAt: null,
      lines: [],
    });
    const refunds = [refundOf(0x71, SO_A, SELLER_A), refundOf(0x72, SO_B, SELLER_B)];
    let orderingDeps: OrderingDependencies;
    beforeEach(() => {
      const orders = new MemoryOrders();
      orders.rows.set(ORDER, paid);
      const refundStore = Object.create(NO_REFUNDS) as RefundRepository;
      refundStore.listForOrder = (_m, orderId) =>
        Promise.resolve(
          refunds
            .filter((r) => r.orderId === orderId)
            .map((refund) => ({ refund, creditNoteId: null })),
        );
      refundStore.listOfSellerOrder = (_m, sellerOrderId, sellerId) =>
        Promise.resolve(
          refunds.filter((r) => r.sellerOrderId === sellerOrderId && r.sellerId === sellerId),
        );
      orderingDeps = {
        unitOfWork: new FakeUnitOfWork(),
        orders,
        refunds: refundStore,
      } as unknown as OrderingDependencies;
    });

    it('declares the admin view key and the seller view key', () => {
      expect(AdminViewOrderActivity.access.rule).toEqual({
        kind: 'permissions',
        allOf: [ORDERING_ORDER_VIEW.key],
      });
      expect(SellerViewOrderActivity.access).toMatchObject({
        rule: { kind: 'permissions', allOf: [VIEW] },
        whenSellerNotApproved: 'deny',
      });
    });

    it('shows the admin every seller order and refund of the order', async () => {
      const read = await new AdminViewOrderActivity(gate, orderingDeps).execute(admin(), {
        orderId: ORDER,
      });
      if (!read.ok) throw new Error(read.error.code);
      expect(read.value.events.map((e) => [e.kind, e.sellerOrderId])).toEqual([
        ['order-placed', null],
        ['order-paid', null],
        ['refund-requested', SO_A],
        ['refund-requested', SO_B],
        ['seller-order-ready', SO_A],
        ['seller-order-ready', SO_B],
      ]);
      expect(read.value.events[2]!.amount).toEqual(money(1000n, currency));
      expect(
        await new AdminViewOrderActivity(gate, orderingDeps).execute(admin(), {
          orderId: id<'Order'>(0x99),
        }),
      ).toEqual({ ok: false, error: { code: 'ordering.order-not-found' } });
    });

    it("shows a seller only its own seller order, and another shop's as unknown", async () => {
      const mine = sellerOf(MEMBER, SELLER_A, [VIEW]);
      const read = await new SellerViewOrderActivity(gate, orderingDeps).execute(mine, {
        sellerOrderId: SO_A,
      });
      if (!read.ok) throw new Error(read.error.code);
      expect(read.value.events.map((e) => [e.kind, e.sellerOrderId])).toEqual([
        ['order-paid', SO_A],
        ['refund-requested', SO_A],
        ['seller-order-ready', SO_A],
      ]);
      expect(
        JSON.stringify(read.value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
      ).not.toMatch(new RegExp(`${SO_B}|${SELLER_B}|${CUSTOMER}`));
      expect(
        await new SellerViewOrderActivity(gate, orderingDeps).execute(mine, {
          sellerOrderId: SO_B,
        }),
      ).toEqual({ ok: false, error: { code: 'ordering.seller-order-not-found' } });
      // An acting-as session reads it as the shop does.
      expect((await sellerActivity(orderingDeps, actingAs(mine), { sellerOrderId: SO_A })).ok).toBe(
        true,
      );
    });

    it('refuses the wrong population, a missing key and a malformed id', async () => {
      held.set(ADMIN, [VIEW]);
      expect(
        await new SellerViewOrderActivity(gate, orderingDeps).execute(admin(), {
          sellerOrderId: SO_A,
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await new AdminViewOrderActivity(gate, orderingDeps).execute(
          sellerOf(MEMBER, SELLER_A, [ORDERING_ORDER_VIEW.key]),
          { orderId: ORDER },
        ),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await new SellerViewOrderActivity(gate, orderingDeps).execute(
          sellerOf(MEMBER, SELLER_A, []),
          { sellerOrderId: SO_A },
        ),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await new AdminViewOrderActivity(gate, orderingDeps).execute(admin(), { orderId: 'x' }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'orderId', code: 'format' }] },
      });
    });
  });
});
