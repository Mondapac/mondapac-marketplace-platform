import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { CartCheckoutFacade, CartCheckoutFailure, CheckoutLine } from '../../src/modules/cart';
import type {
  CustomersCheckoutFacade,
  DeliveryAddress,
  DeliveryAddressFailure,
} from '../../src/modules/customers';
import type {
  CommissionPayoutsFacade,
  CommissionPayoutsFailure,
  CommissionRateMap,
  PaidSellerOrder,
  RefundedSellerOrder,
} from '../../src/modules/commission-payouts';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type {
  CheckoutGateway,
  GatewayFailure,
  RefundAnswer,
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
import type {
  Fulfilment,
  OrderState,
  SellerOrder,
  ShipTo,
} from '../../src/modules/ordering/domain/order';
import type {
  ShipToCipher,
  ShipToKeyDestroyed,
} from '../../src/modules/ordering/application/ports/ship-to-cipher';
import type { OrderTaxCategories } from '../../src/modules/ordering/application/ports/order-tax-categories';
import type { RefundRepository } from '../../src/modules/ordering/application/ports/refund.repository';
import type { TaxAnswer, TaxFacade, TaxFailure, TaxLineInput } from '../../src/modules/tax';
import type {
  CarrierBookingOutcome,
  CarrierDeliveryFailure,
  CarrierDeliveryRequest,
  CarrierShipment,
  CheckoutShippingFees,
  FlatFeeMap,
  QuoteDropoff,
  ShippingFacade,
  ShippingFailure,
} from '../../src/modules/shipping';
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

/** The refund store for specs that never refund (the refund specs use the database). */
export const NO_REFUNDS: RefundRepository = new Proxy({} as RefundRepository, {
  get: (_target, name) => () => Promise.reject(new Error(`refunds.${String(name)} not expected`)),
});

/** The audit writer of tests that write no refund: ordering audits only refunds. */
export const NO_AUDIT: AuditWriter = {
  record: () => Promise.reject(new Error('audit.record not expected')),
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
  countOpenOf(_m: MarketContext, accountId: Id<'Account'>) {
    const openOrders = [...this.rows.values()].filter(
      (o) =>
        o.accountId === accountId &&
        (o.status === 'pending-payment' ||
          (o.status === 'confirmed' && o.sellerOrders.some((s) => s.fulfilment !== 'delivered'))),
    ).length;
    return Promise.resolve({ openOrders, pendingRefunds: 0 });
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
      accountId: order.accountId,
      shipToSealed: order.shipToSealed,
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
  deliveredSellerOrdersOf(
    _m: MarketContext,
    accountId: Id<'Account'>,
    query: {
      readonly deliveredSince: Temporal.Instant;
      readonly sellerOrderId: Id<'SellerOrder'> | null;
      readonly limit: number;
    },
  ) {
    const found: {
      sellerOrderId: Id<'SellerOrder'>;
      sellerId: Id<'Seller'>;
      deliveredAt: Temporal.Instant;
      offerIds: Id<'Offer'>[];
    }[] = [];
    for (const order of this.rows.values()) {
      if (order.accountId !== accountId || order.status !== 'confirmed') continue;
      for (const sellerOrder of order.sellerOrders) {
        if (sellerOrder.fulfilment !== 'delivered' || sellerOrder.deliveredAt === null) continue;
        if (sellerOrder.deliveredAt.epochMilliseconds < query.deliveredSince.epochMilliseconds) {
          continue;
        }
        if (query.sellerOrderId !== null && sellerOrder.id !== query.sellerOrderId) continue;
        found.push({
          sellerOrderId: sellerOrder.id,
          sellerId: sellerOrder.sellerId,
          deliveredAt: sellerOrder.deliveredAt,
          offerIds: [
            ...new Set(
              order.lines.filter((l) => l.sellerOrderId === sellerOrder.id).map((l) => l.offerId),
            ),
          ],
        });
      }
    }
    found.sort(
      (a, b) =>
        b.deliveredAt.epochMilliseconds - a.deliveredAt.epochMilliseconds ||
        b.sellerOrderId.localeCompare(a.sellerOrderId),
    );
    return Promise.resolve(found.slice(0, query.limit));
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
  private patchSeller(
    sellerOrder: SellerOrder,
    allowed: (current: SellerOrder) => boolean,
    apply: (current: SellerOrder) => SellerOrder,
  ) {
    for (const [orderId, order] of this.rows) {
      const index = order.sellerOrders.findIndex((seller) => seller.id === sellerOrder.id);
      if (index < 0) continue;
      const current = order.sellerOrders[index]!;
      if (!allowed(current)) return Promise.resolve('stale' as const);
      const sellerOrders = order.sellerOrders.map((seller, i) =>
        i === index ? apply(seller) : seller,
      );
      this.rows.set(orderId, { ...order, sellerOrders });
      return Promise.resolve('saved' as const);
    }
    return Promise.resolve('stale' as const);
  }
  saveReady(_m: MarketContext, sellerOrder: SellerOrder) {
    return this.patchSeller(
      sellerOrder,
      (current) => current.fulfilment === 'to-ship' && current.readyAt === null,
      (current) => ({ ...current, readyAt: sellerOrder.readyAt }),
    );
  }
  saveAttention(_m: MarketContext, sellerOrder: SellerOrder) {
    return this.patchSeller(
      sellerOrder,
      (current) => current.fulfilment === 'to-ship' && current.deliveryAttention === null,
      (current) => ({ ...current, deliveryAttention: sellerOrder.deliveryAttention }),
    );
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

/**
 * The flat fees `ordering` reads at checkout (a seller without an entry has no fee) and the
 * delivery area: every postcode is delivered to except those in `outside`.
 */
export class FakeShipping implements ShippingFacade {
  fees = new Map<string, Money>();
  outside = new Set<string>();
  down = false;
  deliversTo(_c: CallContext, postcode: string): Promise<Result<boolean, ShippingFailure>> {
    if (this.down) return Promise.resolve(err({ code: 'shipping.unavailable' }));
    return Promise.resolve(ok(!this.outside.has(postcode)));
  }
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
  /** Live quotes per seller id, in place of the flat fee; the drop-offs `shippingFees` was given. */
  quotes = new Map<string, Money>();
  quoteDropoffs: QuoteDropoff[] = [];
  async shippingFees(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
    dropoff: QuoteDropoff,
  ): Promise<Result<CheckoutShippingFees, ShippingFailure>> {
    this.quoteDropoffs.push(dropoff);
    const flat = await this.flatFees(context, sellerIds);
    if (!flat.ok) return flat;
    const fees = new Map(flat.value);
    const quoted = new Set<Id<'Seller'>>();
    for (const sellerId of sellerIds) {
      const quote = this.quotes.get(sellerId);
      if (quote !== undefined) {
        fees.set(sellerId, quote);
        quoted.add(sellerId);
      }
    }
    return ok({ fees, quoted });
  }
  /** What `bookCarrierDelivery` answers per seller order id; `no-carrier` when absent. */
  carrierBookings = new Map<string, Result<CarrierBookingOutcome, CarrierDeliveryFailure>>();
  /** Every booking request, as shipping received it (personal data of fixtures only). */
  carrierRequests: CarrierDeliveryRequest[] = [];
  /** The carrier delivery of each seller order id. */
  carrierShipments = new Map<string, CarrierShipment>();
  carrierDown = false;
  bookCarrierDelivery(
    _c: CallContext,
    request: CarrierDeliveryRequest,
  ): Promise<Result<CarrierBookingOutcome, CarrierDeliveryFailure>> {
    this.carrierRequests.push(request);
    return Promise.resolve(
      this.carrierBookings.get(request.sellerOrderId) ?? ok('no-carrier' as const),
    );
  }
  carrierShipment(
    _c: CallContext,
    sellerOrderId: string,
  ): Promise<Result<CarrierShipment, CarrierDeliveryFailure>> {
    if (this.carrierDown) return Promise.resolve(err({ code: 'shipping.carrier-unavailable' }));
    const shipment = this.carrierShipments.get(sellerOrderId);
    return Promise.resolve(
      shipment === undefined ? err({ code: 'shipping.carrier-delivery-not-found' }) : ok(shipment),
    );
  }
  /** The seller order ids `cancelCarrierDelivery` was asked for, and its answer. */
  carrierCancels: string[] = [];
  cancelAnswer: Result<'cancelled' | 'not-cancellable' | 'none', CarrierDeliveryFailure> = ok(
    'none' as const,
  );
  cancelCarrierDelivery(
    _c: CallContext,
    sellerOrderId: string,
  ): Promise<Result<'cancelled' | 'not-cancellable' | 'none', CarrierDeliveryFailure>> {
    this.carrierCancels.push(sellerOrderId);
    return Promise.resolve(this.cancelAnswer);
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
  /** The refunds the worker sent to the ledger; `refundFails` makes the ledger refuse them. */
  refundsRecorded: RefundedSellerOrder[] = [];
  refundFails: CommissionPayoutsFailure | null = null;
  /** When set, only this refund is refused by `refundFails` (the others are recorded). */
  refundFailOnly: string | null = null;
  recordRefund(
    _c: CallContext,
    refund: RefundedSellerOrder,
  ): Promise<
    Result<'recorded' | 'already-recorded' | 'nothing-to-post', CommissionPayoutsFailure>
  > {
    if (this.refundFails !== null && (this.refundFailOnly ?? refund.refundId) === refund.refundId) {
      return Promise.resolve(err(this.refundFails));
    }
    if (this.refundsRecorded.some((r) => r.refundId === refund.refundId)) {
      return Promise.resolve(ok('already-recorded' as const));
    }
    this.refundsRecorded.push(refund);
    return Promise.resolve(
      ok(refund.lossBearer === 'platform' ? ('nothing-to-post' as const) : ('recorded' as const)),
    );
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
  refunds: Parameters<CheckoutGateway['refund']>[0][] = [];
  refundFails: GatewayFailure | null = null;
  /** Where a refund Stripe makes stands (`succeeded` unless a test says otherwise). */
  refundAnswers: RefundAnswer['status'] = 'succeeded';
  /** The refund ids read back, and where each now stands. */
  statusReads: string[] = [];
  readAnswers: RefundAnswer['status'] = 'succeeded';
  refund(request: Parameters<CheckoutGateway['refund']>[0]) {
    this.refunds.push(request);
    if (this.refundFails !== null) return Promise.resolve(err(this.refundFails));
    // Stripe answers a repeated key with the same refund.
    return Promise.resolve(
      ok({
        refundId: `re_test_${request.idempotencyKey.replace(/[^A-Za-z0-9]/g, '')}`,
        status: this.refundAnswers,
      }),
    );
  }
  refundStatus(stripeRefundId: string) {
    this.statusReads.push(stripeRefundId);
    if (this.refundFails !== null) return Promise.resolve(err(this.refundFails));
    return Promise.resolve(ok({ refundId: stripeRefundId, status: this.readAnswers }));
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
  /** The tax module's reversal arithmetic: per-unit shares, then cumulative half-up shares. */
  reverseRefundTax(
    _c: CallContext,
    input: Parameters<TaxFacade['reverseRefundTax']>[1],
  ): ReturnType<TaxFacade['reverseRefundTax']> {
    if (this.failure !== null) return Promise.resolve(err(this.failure));
    const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);
    return Promise.resolve(
      ok({
        lines: input.lines.map(({ tax, quantity, unitsBefore, units }) => {
          const base = tax / BigInt(quantity);
          const remainder = Number(tax % BigInt(quantity));
          const extra = Math.max(0, Math.min(unitsBefore + units, remainder) - unitsBefore);
          return base * BigInt(units) + BigInt(extra);
        }),
        charges: input.charges.map(({ tax, gross, before, after }) =>
          gross === 0n ? 0n : halfUp(tax * after, gross) - halfUp(tax * before, gross),
        ),
      }),
    );
  }
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

/** A delivery address of the test customer's address book (personal-looking test data only). */
export const TEST_DELIVERY_ADDRESS: DeliveryAddress = {
  recipientFirstName: 'Aisha',
  recipientLastName: 'Rahman',
  phone: '0412345678',
  line1: '12 Example Street',
  line2: null,
  suburb: 'Sunnybank',
  region: 'QLD',
  postcode: '4109',
  deliveryNotes: 'Leave at the door',
  countryCode: 'AU',
};

/** The address books: each address belongs to one account; the caller must own it. */
export class FakeCustomers implements CustomersCheckoutFacade {
  readonly addresses = new Map<string, { accountId: string; address: DeliveryAddress }>();
  failure: DeliveryAddressFailure | null = null;
  readonly calls: unknown[] = [];

  deliveryAddress(
    context: CallContext,
    addressId: unknown,
  ): Promise<Result<DeliveryAddress, DeliveryAddressFailure>> {
    this.calls.push(addressId);
    if (this.failure !== null) return Promise.resolve(err(this.failure));
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    if (typeof addressId !== 'string' || parseId(addressId).ok !== true) {
      return Promise.resolve(err({ code: 'validation.failed' }));
    }
    const found = this.addresses.get(addressId);
    return Promise.resolve(
      found === undefined || found.accountId !== actor.accountId
        ? err({ code: 'customers.address-not-found' })
        : ok(found.address),
    );
  }
}

/** Seals as readable JSON bound to the account; an erased account's key is destroyed. */
export class FakeShipToCipher implements ShipToCipher {
  readonly destroyed = new Set<string>();

  seal(_m: MarketContext, accountId: Id<'Account'>, shipTo: ShipTo) {
    return Promise.resolve(
      this.destroyed.has(accountId)
        ? err<ShipToKeyDestroyed>({ code: 'subject-key.destroyed' })
        : ok(`sealed:${accountId}:${JSON.stringify(shipTo)}`),
    );
  }

  open(_m: MarketContext, accountId: Id<'Account'>, sealed: string) {
    const prefix = `sealed:${accountId}:`;
    if (this.destroyed.has(accountId)) {
      return Promise.resolve(err<ShipToKeyDestroyed>({ code: 'subject-key.destroyed' }));
    }
    if (!sealed.startsWith(prefix)) throw new Error('sealed under another account');
    return Promise.resolve(ok(JSON.parse(sealed.slice(prefix.length)) as ShipTo));
  }
}
