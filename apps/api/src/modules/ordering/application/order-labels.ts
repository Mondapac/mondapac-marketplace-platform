import { Logger } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AdminOrderView, LabelledAdminOrderView } from '../domain/order-views';
import { orderUnitKey, type OrderLabels, type OrderUnitKey } from './ports/order-labels';

const logger = new Logger('OrderLabels');

type Lookup = 'unit-labels' | 'store-names' | 'customers';

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
      lines: seller.lines.map((line) => {
        const unit = unitLabels?.get(orderUnitKey(line));
        return {
          ...line,
          productName: unit?.productName ?? null,
          variantLabel: unit?.variantLabel ?? null,
        };
      }),
    })),
  }));
}
