import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ConfirmPayment } from '../../src/modules/ordering/application/use-cases/confirm-payment.use-case';
import type { OrderingDependencies } from '../../src/modules/ordering/application/checkout-flow';
import { ORDERING_EVENTS } from '../../src/modules/ordering/domain/events';
import type { OrderState } from '../../src/modules/ordering/domain/order';
import { ConfigOrderingPolicy } from '../../src/modules/ordering/infrastructure/config-ordering-policy';
import { PrismaOrderRepository } from '../../src/modules/ordering/infrastructure/prisma-order.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import {
  FakeCart,
  FakeCommission,
  FakeGateway,
  FakeInventory,
  FakeShipping,
} from '../support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Confirming a payment on PostgreSQL, as the application role, for both Market fixtures: the
// order becomes paid and `ordering.order-paid.v1` lands in the ordering outbox in the same unit,
// once, with ids only; and an outbox that refuses rolls the confirmation back (an order is never
// paid without its event).

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)(
  'confirm payment writes the order-paid event in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const currency = code === 'AU' ? 'AUD' : 'JPY';
    const clock = new FixedClock(T0);
    const ids = new UuidV7IdGenerator(clock);
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    let db: Persistence;
    let sql: Client;
    let orders: PrismaOrderRepository;
    let deps: OrderingDependencies;
    let system: CallContext;

    beforeAll(async () => {
      db = createPersistence();
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      orders = new PrismaOrderRepository(db.service);
      const catalogue = new EventCatalogue();
      catalogue.register('ordering', ORDERING_EVENTS);
      catalogue.seal();
      deps = {
        unitOfWork: db.unitOfWork,
        orders,
        gateway: new FakeGateway(),
        policy: new ConfigOrderingPolicy(markets),
        cart: new FakeCart(),
        inventory: new FakeInventory(),
        shipping: new FakeShipping(),
        commission: new FakeCommission(),
        outbox: new PrismaOutboxWriterFactory(
          modelMap,
          db.service,
          catalogue,
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('ordering'),
        ids,
        clock,
      };
      system = testCallContext(market, 'system', `order-paid-${ids.next()}`);
    });
    afterAll(async () => {
      await db.close();
      await sql.end();
    });

    const placeOrder = async (): Promise<OrderState> => {
      const orderId = ids.next<'Order'>();
      const sellerOrderIds = [ids.next<'SellerOrder'>(), ids.next<'SellerOrder'>()];
      const sellerIds = [ids.next<'Seller'>(), ids.next<'Seller'>()];
      const order: OrderState = {
        id: orderId,
        marketId: market.marketId,
        accountId: ids.next<'Account'>(),
        status: 'pending-payment',
        cancelReason: null,
        paymentState: 'none',
        total: money(2500n, currency),
        reservationId: ids.next<'Reservation'>(),
        stripeIdempotencyKey: `checkout-${orderId}`,
        stripeSessionId: `cs_${orderId}`,
        stripePaymentIntentId: null,
        paymentExpiresAt: T0.add({ minutes: 30 }),
        createdAt: T0,
        confirmedAt: null,
        cancelledAt: null,
        version: 1,
        sellerOrders: sellerOrderIds.map((id, index) => ({
          id,
          sellerId: sellerIds[index]!,
          subtotal: 1250n,
          shipping: 0n,
          total: 1250n,
          fulfilment: 'to-ship' as const,
          carrier: null,
          trackingRef: null,
          shippedAt: null,
          deliveredAt: null,
          inventoryRecordedAt: null,
          ledgerState: 'pending' as const,
        })),
        lines: sellerOrderIds.map((sellerOrderId) => ({
          id: ids.next<'OrderLine'>(),
          sellerOrderId,
          offerId: ids.next<'Offer'>(),
          variantId: ids.next<'Variant'>(),
          quantity: 1,
          unitPrice: money(1250n, currency),
          lineAmount: 1250n,
          taxInclusive: true,
          reservationLineId: ids.next<'ReservationLine'>(),
          commissionRateBps: 1500,
        })),
      };
      const stored = await db.unitOfWork.run(market, async () => {
        await orders.insert(market, order);
        return ok(undefined);
      });
      if (!stored.ok) throw new Error('could not store the order');
      return order;
    };

    const confirm = (use: OrderingDependencies, order: OrderState) =>
      new ConfirmPayment(gate, use).execute(system, {
        orderId: order.id,
        paymentIntentId: `pi_${order.id}`,
        sessionId: `cs_${order.id}`,
        amount: order.total,
      });
    const eventsOf = async (orderId: Id<'Order'>) =>
      (
        await sql.query<{
          type: string;
          payload: Record<string, unknown>;
          aggregate_version: number;
        }>(
          `SELECT type, payload, aggregate_version FROM ordering.outbox
          WHERE market_id = $1 AND aggregate_id = $2`,
          [market.marketId, orderId],
        )
      ).rows;
    const statusOf = async (orderId: Id<'Order'>) =>
      (
        await sql.query<{ status: string }>(
          'SELECT status FROM ordering.orders WHERE market_id = $1 AND id = $2',
          [market.marketId, orderId],
        )
      ).rows[0]?.status;

    it('writes one order-paid event with ids only in the unit that confirms the order', async () => {
      const order = await placeOrder();

      expect(await confirm(deps, order)).toEqual(ok('confirmed'));
      // A repeated delivery changes nothing and writes nothing.
      expect(await confirm(deps, order)).toEqual(ok('already-confirmed'));

      expect(await statusOf(order.id)).toBe('confirmed');
      const events = await eventsOf(order.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'ordering.order-paid.v1', aggregate_version: 3 });
      // The store returns seller orders in its own order; the two lists stay in step.
      const payload = events[0]!.payload as {
        orderId: string;
        sellerOrderIds: string[];
        sellerIds: string[];
      };
      expect(payload.orderId).toBe(order.id);
      expect(payload.sellerOrderIds.slice().sort()).toEqual(
        order.sellerOrders.map((sellerOrder) => sellerOrder.id).sort(),
      );
      for (const [index, sellerOrderId] of payload.sellerOrderIds.entries()) {
        const sellerOrder = order.sellerOrders.find((candidate) => candidate.id === sellerOrderId);
        expect(payload.sellerIds[index]).toBe(sellerOrder?.sellerId);
      }
      expect(JSON.stringify(events[0]!.payload)).not.toMatch(/@|email|amount/i);
    });

    it('does not confirm the order when the outbox refuses the event', async () => {
      const order = await placeOrder();
      const refusing: OutboxWriter = { append: () => Promise.reject(new Error('outbox down')) };

      await expect(confirm({ ...deps, outbox: refusing }, order)).rejects.toThrow('outbox down');

      expect(await statusOf(order.id)).not.toBe('confirmed');
      expect(await eventsOf(order.id)).toEqual([]);
    });
  },
);
