import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { CartCheckoutFacade, CartCheckoutFailure, CheckoutLine } from '../../src/modules/cart';
import type {
  CommissionPayoutsFacade,
  CommissionPayoutsFailure,
  CommissionRateMap,
  PaidSellerOrder,
} from '../../src/modules/commission-payouts';
import type {
  CheckoutGateway,
  GatewayFailure,
} from '../../src/modules/ordering/application/ports/checkout-gateway';
import {
  orderUnitKey,
  type OrderCustomer,
  type OrderLabels,
  type OrderUnitKey,
  type OrderUnitLabel,
} from '../../src/modules/ordering/application/ports/order-labels';
import type {
  OrderFilter,
  OrderPage,
  OrderRepository,
  SellerOrderFilter,
  SellerOrderPage,
  SellerOrderRecord,
} from '../../src/modules/ordering/application/ports/order.repository';
import type { Fulfilment, OrderState, SellerOrder } from '../../src/modules/ordering/domain/order';
import type { OrderTaxCategories } from '../../src/modules/ordering/application/ports/order-tax-categories';
import type { TaxAnswer, TaxFacade, TaxFailure, TaxLineInput } from '../../src/modules/tax';
import type { FlatFeeMap, ShippingFacade, ShippingFailure } from '../../src/modules/shipping';
import type {
  CommitFailure,
  InventoryOrderingPort,
  LineCommandFailure,
  ReserveFailure,
} from '../../src/modules/inventory/contracts/ordering-port';
import { parseId } from '@mondapac/shared-kernel';

// In-memory ports of ordering for the use-case spec and the HTTP spec: the order store, the
// payment gateway, inventory's ordering port and the cart's checkout facade.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

export class MemoryOrders implements OrderRepository {
  readonly rows = new Map<string, OrderState>();
  insert(_m: MarketContext, order: OrderState) {
    this.rows.set(order.id, order);
    return Promise.resolve();
  }
  findById(_m: MarketContext, orderId: Id<'Order'>) {
    return Promise.resolve(this.rows.get(orderId) ?? null);
  }
  findOwn(_m: MarketContext, orderId: Id<'Order'>, accountId: Id<'Account'>) {
    const order = this.rows.get(orderId);
    return Promise.resolve(order?.accountId === accountId ? order : null);
  }
  findPending(_m: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (o) => o.accountId === accountId && o.status === 'pending-payment',
      ),
    );
  }
  private newestFirst(rows: OrderState[], page: OrderPage) {
    return rows
      .sort(
        (a, b) =>
          b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds || b.id.localeCompare(a.id),
      )
      .filter(
        (o) =>
          page.after === null ||
          o.createdAt.epochMilliseconds < page.after.createdAt.epochMilliseconds ||
          (o.createdAt.epochMilliseconds === page.after.createdAt.epochMilliseconds &&
            o.id < page.after.id),
      )
      .slice(0, page.limit);
  }
  listOwn(_m: MarketContext, accountId: Id<'Account'>, page: OrderPage) {
    return Promise.resolve(
      this.newestFirst(
        [...this.rows.values()].filter((o) => o.accountId === accountId),
        page,
      ),
    );
  }
  listAll(_m: MarketContext, filter: OrderFilter, page: OrderPage) {
    return Promise.resolve(
      this.newestFirst(
        [...this.rows.values()].filter(
          (o) =>
            (filter.status === null || o.status === filter.status) &&
            (filter.reference === null ||
              o.id === filter.reference ||
              o.sellerOrders.some((s) => s.id === filter.reference)),
        ),
        page,
      ),
    );
  }
  countAll() {
    const all = [...this.rows.values()];
    const count = (status: OrderState['status']) => all.filter((o) => o.status === status).length;
    return Promise.resolve({
      pendingPayment: count('pending-payment'),
      confirmed: count('confirmed'),
      cancelled: count('cancelled'),
    });
  }
  save(_m: MarketContext, order: OrderState) {
    const stored = this.rows.get(order.id);
    if (stored === undefined || stored.version !== order.version)
      return Promise.resolve('stale' as const);
    // Like the real store, `save` leaves the fulfilment of the seller orders alone.
    this.rows.set(order.id, {
      ...order,
      sellerOrders: stored.sellerOrders,
      version: order.version + 1,
    });
    return Promise.resolve('saved' as const);
  }

  private recordOf(order: OrderState, sellerOrder: SellerOrder): SellerOrderRecord {
    return {
      sellerOrder,
      orderId: order.id,
      currency: order.total.currency,
      confirmedAt: order.confirmedAt!,
      lines: order.lines.filter((line) => line.sellerOrderId === sellerOrder.id),
    };
  }
  private paid(sellerId: Id<'Seller'> | null): SellerOrderRecord[] {
    return [...this.rows.values()]
      .filter((order) => order.status === 'confirmed')
      .flatMap((order) =>
        order.sellerOrders
          .filter((seller) => sellerId === null || seller.sellerId === sellerId)
          .map((seller) => this.recordOf(order, seller)),
      );
  }
  listForSeller(
    _m: MarketContext,
    sellerId: Id<'Seller'>,
    filter: SellerOrderFilter,
    page: SellerOrderPage,
  ) {
    const after = page.after;
    return Promise.resolve(
      this.paid(sellerId)
        .filter((r) => filter.fulfilment === null || r.sellerOrder.fulfilment === filter.fulfilment)
        .sort(
          (a, b) =>
            b.confirmedAt.epochMilliseconds - a.confirmedAt.epochMilliseconds ||
            b.sellerOrder.id.localeCompare(a.sellerOrder.id),
        )
        .filter(
          (r) =>
            after === null ||
            r.confirmedAt.epochMilliseconds < after.confirmedAt.epochMilliseconds ||
            (r.confirmedAt.epochMilliseconds === after.confirmedAt.epochMilliseconds &&
              r.sellerOrder.id < after.id),
        )
        .slice(0, page.limit),
    );
  }
  countForSeller(_m: MarketContext, sellerId: Id<'Seller'>) {
    const paid = this.paid(sellerId);
    const count = (step: Fulfilment) =>
      paid.filter((r) => r.sellerOrder.fulfilment === step).length;
    return Promise.resolve({
      toShip: count('to-ship'),
      shipped: count('shipped'),
      delivered: count('delivered'),
    });
  }
  findForSeller(_m: MarketContext, sellerId: Id<'Seller'>, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(
      this.paid(sellerId).find((record) => record.sellerOrder.id === sellerOrderId) ?? null,
    );
  }
  customerAccountsForSeller(
    _m: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ) {
    const wanted = new Set(sellerOrderIds);
    const accounts = new Map<Id<'SellerOrder'>, Id<'Account'>>();
    for (const order of this.rows.values()) {
      if (order.status !== 'confirmed') continue;
      for (const sellerOrder of order.sellerOrders) {
        if (sellerOrder.sellerId === sellerId && wanted.has(sellerOrder.id)) {
          accounts.set(sellerOrder.id, order.accountId);
        }
      }
    }
    return Promise.resolve(accounts);
  }
  saveFulfilment(_m: MarketContext, sellerOrder: SellerOrder, from: Fulfilment) {
    for (const [orderId, order] of this.rows) {
      const index = order.sellerOrders.findIndex((seller) => seller.id === sellerOrder.id);
      if (index < 0) continue;
      if (order.sellerOrders[index]!.fulfilment !== from) return Promise.resolve('stale' as const);
      const sellerOrders = order.sellerOrders.map((seller, i) =>
        i === index ? { ...sellerOrder, inventoryRecordedAt: seller.inventoryRecordedAt } : seller,
      );
      this.rows.set(orderId, { ...order, sellerOrders });
      return Promise.resolve('saved' as const);
    }
    return Promise.resolve('stale' as const);
  }
  findUnrecordedShipments(_m: MarketContext, limit: number) {
    return Promise.resolve(
      this.paid(null)
        .filter(
          (r) =>
            r.sellerOrder.fulfilment !== 'to-ship' && r.sellerOrder.inventoryRecordedAt === null,
        )
        .slice(0, limit),
    );
  }
  findUnrecordedLedger(_m: MarketContext, limit: number) {
    return Promise.resolve(
      this.paid(null)
        .filter((r) => r.sellerOrder.ledgerState === 'pending')
        .sort(
          (a, b) =>
            (this.ledgerFailures.get(a.sellerOrder.id) ?? 0) -
            (this.ledgerFailures.get(b.sellerOrder.id) ?? 0),
        )
        .slice(0, limit),
    );
  }
  ledgerFailures = new Map<string, number>();
  countLedgerFailure(_m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    const attempts = (this.ledgerFailures.get(sellerOrderId) ?? 0) + 1;
    this.ledgerFailures.set(sellerOrderId, attempts);
    return Promise.resolve(attempts);
  }
  markLedgerRecorded(_m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    for (const [orderId, order] of this.rows) {
      if (!order.sellerOrders.some((seller) => seller.id === sellerOrderId)) continue;
      const sellerOrders = order.sellerOrders.map((seller) =>
        seller.id === sellerOrderId && seller.ledgerState === 'pending'
          ? { ...seller, ledgerState: 'recorded' as const }
          : seller,
      );
      this.rows.set(orderId, { ...order, sellerOrders });
    }
    return Promise.resolve();
  }
  markInventoryRecorded(_m: MarketContext, sellerOrderId: Id<'SellerOrder'>, at: Temporal.Instant) {
    for (const [orderId, order] of this.rows) {
      if (!order.sellerOrders.some((seller) => seller.id === sellerOrderId)) continue;
      const sellerOrders = order.sellerOrders.map((seller) =>
        seller.id === sellerOrderId && seller.inventoryRecordedAt === null
          ? { ...seller, inventoryRecordedAt: at }
          : seller,
      );
      this.rows.set(orderId, { ...order, sellerOrders });
    }
    return Promise.resolve();
  }
}

/** The flat fees `ordering` reads at checkout; a seller without an entry has no fee. */
export class FakeShipping implements ShippingFacade {
  fees = new Map<string, Money>();
  down = false;
  flatFees(
    _c: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<FlatFeeMap, ShippingFailure>> {
    if (this.down) return Promise.resolve(err({ code: 'shipping.unavailable' }));
    return Promise.resolve(
      ok(
        new Map(
          sellerIds.flatMap((sellerId) => {
            const fee = this.fees.get(sellerId);
            return fee === undefined ? [] : [[sellerId, fee] as const];
          }),
        ),
      ),
    );
  }
}

/**
 * The commission rates `ordering` freezes at checkout (a seller without an entry is on
 * `marketRateBps`) and the paid seller orders its worker sends to the ledger.
 */
export class FakeCommission implements CommissionPayoutsFacade {
  rates = new Map<string, number>();
  marketRateBps = 1500;
  down = false;
  recordFails: CommissionPayoutsFailure | null = null;
  recorded: PaidSellerOrder[] = [];
  commissionRates(
    _c: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<CommissionRateMap, CommissionPayoutsFailure>> {
    if (this.down) return Promise.resolve(err({ code: 'commission-payouts.rate-unavailable' }));
    return Promise.resolve(
      ok(
        new Map(
          sellerIds.map((sellerId) => {
            const own = this.rates.get(sellerId);
            return [
              sellerId,
              own === undefined
                ? { rateBps: this.marketRateBps, source: 'market' as const }
                : { rateBps: own, source: 'seller' as const },
            ] as const;
          }),
        ),
      ),
    );
  }
  recordSellerOrderPaid(
    _c: CallContext,
    paid: PaidSellerOrder,
  ): Promise<Result<'recorded' | 'already-recorded', CommissionPayoutsFailure>> {
    if (this.recordFails !== null) return Promise.resolve(err(this.recordFails));
    if (this.recorded.some((r) => r.sellerOrderId === paid.sellerOrderId)) {
      return Promise.resolve(ok('already-recorded' as const));
    }
    this.recorded.push(paid);
    return Promise.resolve(ok('recorded' as const));
  }
}

export class FakeGateway implements CheckoutGateway {
  sessions: Parameters<CheckoutGateway['createSession']>[0][] = [];
  expired: string[] = [];
  captured: [string, string][] = [];
  voided: [string, string][] = [];
  createFails: GatewayFailure | null = null;
  captureFails: GatewayFailure | null = null;
  voidFails: GatewayFailure | null = null;
  createSession(request: Parameters<CheckoutGateway['createSession']>[0]) {
    if (this.createFails !== null) return Promise.resolve(err(this.createFails));
    this.sessions.push(request);
    const n = this.sessions.length;
    return Promise.resolve(
      ok({ sessionId: `cs_test_${n}`, url: `https://checkout.stripe.test/c/cs_test_${n}` }),
    );
  }
  expireSession(sessionId: string) {
    this.expired.push(sessionId);
    return Promise.resolve();
  }
  capture(paymentIntentId: string, key: string) {
    if (this.captureFails !== null) return Promise.resolve(err(this.captureFails));
    this.captured.push([paymentIntentId, key]);
    return Promise.resolve(ok(true as const));
  }
  voidAuthorisation(paymentIntentId: string, key: string) {
    if (this.voidFails !== null) return Promise.resolve(err(this.voidFails));
    this.voided.push([paymentIntentId, key]);
    return Promise.resolve(ok(true as const));
  }
}

export class FakeInventory implements InventoryOrderingPort {
  calls: string[] = [];
  reserveFails: ReserveFailure | null = null;
  reserveFailuresLeft = 0;
  commitFails: CommitFailure | null = null;
  commitFailuresLeft = 0;
  releaseCommitted = false;
  reserved: Parameters<InventoryOrderingPort['reserve']>[1][] = [];
  committed: unknown[] = [];
  reserve(_c: CallContext, request: Parameters<InventoryOrderingPort['reserve']>[1]) {
    this.calls.push('reserve');
    if (this.reserveFails !== null) {
      if (this.reserveFails.code !== 'conflict.retry' || this.reserveFailuresLeft-- > 0) {
        return Promise.resolve(err(this.reserveFails));
      }
    }
    this.reserved.push(request);
    return Promise.resolve(
      ok({
        reservationId: id<'Reservation'>(0x700 + this.reserved.length),
        expiresAt: T0.add({ minutes: 15 }),
        lines: request.lines.map((line, index) => ({
          offerId: line.offerId,
          variantId: line.variantId,
          reservationLineId: id<'ReservationLine'>(0x800 + index),
        })),
      }),
    );
  }
  releaseReservation(_c: CallContext, request: { reservationId: string; cause: string }) {
    this.calls.push(`release:${request.cause}`);
    if (this.releaseCommitted) {
      return Promise.resolve(err({ code: 'inventory.reservation.committed' } as const));
    }
    return Promise.resolve(ok({ reservationId: request.reservationId as Id<'Reservation'> }));
  }
  releaseOwnReservation(_c: CallContext, request: { reservationId: string }) {
    this.calls.push('release-own');
    return Promise.resolve(ok({ reservationId: request.reservationId as Id<'Reservation'> }));
  }
  commitReservation(
    _c: CallContext,
    request: Parameters<InventoryOrderingPort['commitReservation']>[1],
  ) {
    this.calls.push('commit');
    if (this.commitFails !== null) {
      if (this.commitFails.code !== 'conflict.retry' || this.commitFailuresLeft-- > 0) {
        return Promise.resolve(err(this.commitFails));
      }
    }
    this.committed.push(request);
    return Promise.resolve(ok({ reservationId: request.reservationId as Id<'Reservation'> }));
  }
  cancelCommittedLine(_c: CallContext, request: { orderLineId: string }) {
    this.calls.push(`cancel-line:${request.orderLineId}`);
    return Promise.resolve(ok({ orderLineId: request.orderLineId }));
  }
  shipped: string[] = [];
  shipmentFails: LineCommandFailure | null = null;
  recordShipment(_c: CallContext, request: { orderLineId: string }) {
    if (this.shipmentFails !== null) return Promise.resolve(err(this.shipmentFails));
    this.shipped.push(request.orderLineId);
    return Promise.resolve(ok({ orderLineId: request.orderLineId }));
  }
}

export class FakeCart implements CartCheckoutFacade {
  lines: readonly CheckoutLine[] = [];
  down = false;
  cleared: unknown[] = [];
  notReady: Extract<CartCheckoutFailure, { code: 'cart.not-ready' }> | null = null;
  checkoutLines(): Promise<Result<readonly CheckoutLine[], CartCheckoutFailure>> {
    if (this.notReady !== null) return Promise.resolve(err(this.notReady));
    return Promise.resolve(this.down ? err({ code: 'cart.check-unavailable' }) : ok(this.lines));
  }
  clearOrdered(_c: CallContext, request: unknown) {
    this.cleared.push(request);
    return Promise.resolve(ok({ removed: 1 }));
  }
}

/** Names by key; `fail` makes a lookup throw, as an adapter does on a refusal. */
export class FakeLabels implements OrderLabels {
  readonly units = new Map<string, OrderUnitLabel>();
  readonly stores = new Map<Id<'Seller'>, string>();
  readonly customers = new Map<Id<'Account'>, OrderCustomer>();
  readonly shortNames = new Map<Id<'Account'>, string>();
  readonly fail = new Set<'units' | 'stores' | 'customers' | 'short-names'>();
  readonly calls: { readonly lookup: string; readonly count: number }[] = [];

  unitLabelsOf(
    _context: CallContext,
    keys: readonly OrderUnitKey[],
  ): Promise<ReadonlyMap<string, OrderUnitLabel>> {
    this.calls.push({ lookup: 'units', count: keys.length });
    if (this.fail.has('units')) return Promise.reject(new Error('units'));
    return Promise.resolve(this.units);
  }

  storeNamesOf(
    _context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    this.calls.push({ lookup: 'stores', count: sellerIds.length });
    if (this.fail.has('stores')) return Promise.reject(new Error('stores'));
    return Promise.resolve(this.stores);
  }

  customersOf(
    _context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, OrderCustomer>> {
    this.calls.push({ lookup: 'customers', count: accountIds.length });
    if (this.fail.has('customers')) return Promise.reject(new Error('customers'));
    return Promise.resolve(this.customers);
  }

  customerShortNamesOf(
    _context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, string>> {
    this.calls.push({ lookup: 'short-names', count: accountIds.length });
    if (this.fail.has('short-names')) return Promise.reject(new Error('short-names'));
    return Promise.resolve(this.shortNames);
  }

  /** Sets the label of one (Offer, Variant). */
  label(key: OrderUnitKey, productName: string, variantLabel: string | null): void {
    this.units.set(orderUnitKey(key), { productName, variantLabel });
  }
}

/**
 * The tax category of each Offer bought, as checkout reads it from catalog: `byOffer` first, then
 * `fallback` (a category code of the Market under test), a switch to fail, and the asked ids.
 */
export class FakeTaxCategories implements OrderTaxCategories {
  readonly byOffer = new Map<Id<'Offer'>, string>();
  /** Offers the catalog does not know (no published revision): absent from the answer. */
  readonly unknown = new Set<Id<'Offer'>>();
  fail = false;
  calls: (readonly Id<'Offer'>[])[] = [];

  constructor(private readonly fallback: string) {}

  categoriesOf(
    _context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, string>> {
    this.calls.push(offerIds);
    if (this.fail) return Promise.reject(new Error('taxCategories'));
    return Promise.resolve(
      new Map(
        offerIds
          .filter((id) => !this.unknown.has(id))
          .map((id) => [id, this.byOffer.get(id) ?? this.fallback] as const),
      ),
    );
  }
}

/**
 * The tax facade as checkout uses it: one flat rate for every line (half-up, inclusive or
 * exclusive as the line says), the strategy id it answers, and a switch to fail.
 */
export class FakeTax implements TaxFacade {
  rateBps = 1000;
  strategyId: TaxAnswer['strategyId'] = null;
  failure: TaxFailure | null = null;
  /** Answer one line fewer than asked, as a broken tax module would. */
  dropLast = false;
  calls: (readonly TaxLineInput[])[] = [];
  calculateTax(
    _c: CallContext,
    lines: readonly TaxLineInput[],
  ): Promise<Result<TaxAnswer, TaxFailure>> {
    this.calls.push(lines);
    if (this.failure !== null) return Promise.resolve(err(this.failure));
    const rate = BigInt(this.rateBps);
    const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);
    return Promise.resolve(
      ok({
        strategyId: this.strategyId,
        lines: (this.dropLast ? lines.slice(0, -1) : lines).map((line) => {
          const tax = line.taxInclusive
            ? halfUp(line.amount * rate, 10_000n + rate)
            : halfUp(line.amount * rate, 10_000n);
          return line.taxInclusive
            ? { rateBps: this.rateBps, tax, net: line.amount - tax, gross: line.amount }
            : { rateBps: this.rateBps, tax, net: line.amount, gross: line.amount + tax };
        }),
      }),
    );
  }
}
