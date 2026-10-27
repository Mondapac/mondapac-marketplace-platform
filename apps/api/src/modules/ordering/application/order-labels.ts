import { Logger } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type {
  AdminOrderView,
  LabelledSellerOrderView,
  OrderView,
  LabelledAdminOrderView,
  LabelledLineView,
  LabelledSellerOrderDetailView,
  OrderLineView,
  SellerOrderDetailView,
} from '../domain/order-views';
import { orderUnitKey, type OrderLabels, type OrderUnitKey } from './ports/order-labels';

const logger = new Logger('OrderLabels');

type Lookup = 'unit-labels' | 'store-names' | 'customers' | 'customer-short-names';

function settled<T>(
  context: CallContext,
  lookup: Lookup,
  outcome: PromiseSettledResult<T>,
): T | undefined {
  if (outcome.status === 'fulfilled') return outcome.value;
  logger.warn({
    msg: 'ordering.order-labels.lookup-failed',
    lookup,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return undefined;
}

/**
 * Adds the product names, Variant labels, store names and customer to a page of admin orders:
 * ONE batched call per lookup, with distinct keys, in parallel, after the read unit has closed
 * (no facade call inside a unit). The caller's `CallContext` goes through unchanged. A failed
 * lookup is logged (never a name) and leaves its fields null: it never fails the read.
 */
export async function labelAdminOrders(
  labels: OrderLabels,
  context: CallContext,
  orders: readonly AdminOrderView[],
): Promise<readonly LabelledAdminOrderView[]> {
  if (orders.length === 0) return [];
  const units = new Map<string, OrderUnitKey>();
  const sellerIds = new Set<Id<'Seller'>>();
  for (const order of orders) {
    for (const seller of order.sellerOrders) {
      sellerIds.add(seller.sellerId);
      for (const line of seller.lines) {
        units.set(orderUnitKey(line), { offerId: line.offerId, variantId: line.variantId });
      }
    }
  }
  const accountIds = [...new Set(orders.map((order) => order.accountId))];
  const [unitAnswer, storeAnswer, customerAnswer] = await Promise.allSettled([
    labels.unitLabelsOf(context, [...units.values()]),
    labels.storeNamesOf(context, [...sellerIds]),
    labels.customersOf(context, accountIds),
  ]);
  const unitLabels = settled(context, 'unit-labels', unitAnswer);
  const storeNames = settled(context, 'store-names', storeAnswer);
  const customers = settled(context, 'customers', customerAnswer);
  return orders.map((order) => ({
    ...order,
    customer: customers?.get(order.accountId) ?? null,
    sellerOrders: order.sellerOrders.map((seller) => ({
      ...seller,
      storeName: storeNames?.get(seller.sellerId) ?? null,
      lines: labelLines(seller.lines, unitLabels),
    })),
  }));
}

/**
 * Adds the product names, Variant labels and store names to the customer's own orders: ONE
 * batched call per lookup, in parallel, after the read unit has closed. A failed lookup is logged
 * and leaves its fields null; it never fails the read.
 */
export async function labelOwnOrders<V extends OrderView>(
  labels: OrderLabels,
  context: CallContext,
  orders: readonly V[],
): Promise<(Omit<V, 'sellerOrders'> & { sellerOrders: readonly LabelledSellerOrderView[] })[]> {
  if (orders.length === 0) return [];
  const units = new Map<string, OrderUnitKey>();
  const sellerIds = new Set<Id<'Seller'>>();
  for (const order of orders) {
    for (const seller of order.sellerOrders) {
      sellerIds.add(seller.sellerId);
      for (const line of seller.lines) {
        units.set(orderUnitKey(line), { offerId: line.offerId, variantId: line.variantId });
      }
    }
  }
  const [unitAnswer, storeAnswer] = await Promise.allSettled([
    labels.unitLabelsOf(context, [...units.values()]),
    labels.storeNamesOf(context, [...sellerIds]),
  ]);
  const unitLabels = settled(context, 'unit-labels', unitAnswer);
  const storeNames = settled(context, 'store-names', storeAnswer);
  return orders.map((order) => ({
    ...order,
    sellerOrders: order.sellerOrders.map((seller) => ({
      ...seller,
      storeName: storeNames?.get(seller.sellerId) ?? null,
      lines: labelLines(seller.lines, unitLabels),
    })),
  }));
}

function labelLines(
  lines: readonly OrderLineView[],
  unitLabels: ReadonlyMap<string, { productName: string; variantLabel: string | null }> | undefined,
): LabelledLineView[] {
  return lines.map((line) => {
    const unit = unitLabels?.get(orderUnitKey(line));
    return {
      ...line,
      productName: unit?.productName ?? null,
      variantLabel: unit?.variantLabel ?? null,
    };
  });
}

/**
 * Adds the published product name and Variant label to the lines of the seller's own seller
 * orders: ONE batched catalog call per page, with distinct keys, after the unit has closed. A
 * failed lookup is logged and leaves the names null; it never fails the read or the step.
 */
export async function labelSellerOrders(
  labels: OrderLabels,
  context: CallContext,
  orders: readonly SellerOrderDetailView[],
): Promise<readonly LabelledSellerOrderDetailView[]> {
  if (orders.length === 0) return [];
  const units = new Map<string, OrderUnitKey>();
  for (const order of orders) {
    for (const line of order.lines) {
      units.set(orderUnitKey(line), { offerId: line.offerId, variantId: line.variantId });
    }
  }
  const [answer] = await Promise.allSettled([labels.unitLabelsOf(context, [...units.values()])]);
  const unitLabels = settled(context, 'unit-labels', answer);
  return orders.map((order) => ({ ...order, lines: labelLines(order.lines, unitLabels) }));
}

/**
 * The short customer name of each seller order in `accounts` (seller order to customer account),
 * in ONE batched call after the read unit has closed. A failed lookup is logged (never a name)
 * and answers no names; a customer without a name, or a member without the key, is absent.
 */
export async function shortNamesOfSellerOrders(
  labels: OrderLabels,
  context: CallContext,
  accounts: ReadonlyMap<Id<'SellerOrder'>, Id<'Account'>>,
): Promise<ReadonlyMap<Id<'SellerOrder'>, string>> {
  if (accounts.size === 0) return new Map();
  const [answer] = await Promise.allSettled([
    labels.customerShortNamesOf(context, [...new Set(accounts.values())]),
  ]);
  const names = settled(context, 'customer-short-names', answer);
  const out = new Map<Id<'SellerOrder'>, string>();
  if (names === undefined) return out;
  for (const [sellerOrderId, accountId] of accounts) {
    const name = names.get(accountId);
    if (name !== undefined) out.set(sellerOrderId, name);
  }
  return out;
}
