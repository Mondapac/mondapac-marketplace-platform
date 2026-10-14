import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { CartCheckoutFacade, CheckoutLine } from '../../src/modules/cart';
import type {
  CheckoutGateway,
  GatewayFailure,
} from '../../src/modules/ordering/application/ports/checkout-gateway';
import type {
  OrderPage,
  OrderRepository,
} from '../../src/modules/ordering/application/ports/order.repository';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import type {
  CommitFailure,
  InventoryOrderingPort,
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
  listAll(_m: MarketContext, filter: { status: OrderState['status'] | null }, page: OrderPage) {
    return Promise.resolve(
      this.newestFirst(
        [...this.rows.values()].filter((o) => filter.status === null || o.status === filter.status),
        page,
      ),
    );
  }
  save(_m: MarketContext, order: OrderState) {
    const stored = this.rows.get(order.id);
    if (stored === undefined || stored.version !== order.version)
      return Promise.resolve('stale' as const);
    this.rows.set(order.id, { ...order, version: order.version + 1 });
    return Promise.resolve('saved' as const);
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
  recordShipment(_c: CallContext, request: { orderLineId: string }) {
    return Promise.resolve(ok({ orderLineId: request.orderLineId }));
  }
}

export class FakeCart implements CartCheckoutFacade {
  lines: readonly CheckoutLine[] = [];
  down = false;
  cleared: unknown[] = [];
  checkoutLines(): Promise<Result<readonly CheckoutLine[], { code: 'cart.check-unavailable' }>> {
    return Promise.resolve(this.down ? err({ code: 'cart.check-unavailable' }) : ok(this.lines));
  }
  clearOrdered(_c: CallContext, request: unknown) {
    this.cleared.push(request);
    return Promise.resolve(ok({ removed: 1 }));
  }
}
