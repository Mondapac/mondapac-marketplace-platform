import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { OrderState, SellerOrder } from '../domain/order';
import type { OwnPickupCodeView } from '../domain/order-views';
import { pickupStatusOf, type PickupCodeRecord, type PickupStatus } from '../domain/pickup-code';
import type { OrderingDependencies } from './checkout-flow';

// The buyer's side of the pickup code (delivery models, package 2) and the status the seller
// panel shows. The code is made when the seller marks a pickup order ready (see the fulfilment
// flow) and is read only by the buyer who placed the order. Nothing here logs, returns to the
// seller or writes into an event the code itself.

const logger = new Logger('OrderingPickupFlow');

export type PickupFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'ordering.order-not-found' }
  /** The part is not a pickup, not ready, or already collected: there is no code to renew. */
  | { readonly code: 'ordering.fulfilment-conflict' };

/** A pickup part that is ready and not collected yet: the only state in which a code is live. */
export const awaitsHandover = (sellerOrder: SellerOrder): boolean =>
  sellerOrder.deliveryMethod === 'pickup' &&
  sellerOrder.fulfilment === 'to-ship' &&
  sellerOrder.readyAt !== null;

/**
 * The seller panel's view of a pickup order's code, read in the open unit: the tries left and the
 * lock; null for any order that is not waiting for its handover. Never the code.
 */
export async function pickupStatusFor(
  deps: OrderingDependencies,
  market: MarketContext,
  sellerOrder: SellerOrder,
): Promise<PickupStatus | null> {
  if (!awaitsHandover(sellerOrder)) return null;
  const stored = await deps.pickupCodes.find(market, sellerOrder.id);
  return stored === null ? null : pickupStatusOf(stored);
}

/** The stored codes of the order's parts that wait for their handover, read in the open unit. */
export async function storedPickupCodes(
  deps: OrderingDependencies,
  market: MarketContext,
  order: OrderState,
): Promise<ReadonlyMap<Id<'SellerOrder'>, PickupCodeRecord>> {
  const waiting = order.sellerOrders.filter(awaitsHandover).map((seller) => seller.id);
  return waiting.length === 0 ? new Map() : deps.pickupCodes.findMany(market, waiting);
}

/**
 * Opens the sealed codes of the buyer's own order. A code that cannot be opened (the account was
 * erased, or the copy is damaged) is left out and logged as a code with ids only: the order stays
 * readable without it.
 */
export async function openPickupCodes(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  order: OrderState,
  stored: ReadonlyMap<Id<'SellerOrder'>, PickupCodeRecord>,
): Promise<readonly OwnPickupCodeView[]> {
  const opened: OwnPickupCodeView[] = [];
  for (const seller of order.sellerOrders) {
    const record = stored.get(seller.id);
    if (record === undefined) continue;
    try {
      const code = await deps.pickupVault.reveal(
        context.market,
        accountId,
        seller.id,
        record.sealed,
      );
      if (code.ok) {
        opened.push({ sellerId: seller.sellerId, code: code.value, ...pickupStatusOf(record) });
      }
    } catch (error) {
      logger.error({
        msg: 'ordering.pickup-code-unreadable',
        errorName: error instanceof Error ? error.name : 'unknown',
        sellerOrderId: seller.id,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  return opened;
}

/**
 * The buyer asks for a new code for one pickup part of their own order: the old code stops
 * working, the failure count goes back to zero and a lock is lifted (this is how a locked order
 * is opened again). Only a pickup part that is ready and not collected has a code to renew.
 * Unknown and foreign orders are one answer. The new code is answered to the buyer only.
 */
export async function regeneratePickupCode(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly orderId: unknown; readonly sellerId: unknown },
): Promise<Result<OwnPickupCodeView, PickupFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const sellerId = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
  const fields: { path: string; code: string }[] = [];
  if (orderId === null || !orderId.ok) fields.push({ path: 'orderId', code: 'format' });
  if (sellerId === null || !sellerId.ok) fields.push({ path: 'sellerId', code: 'format' });
  if (fields.length > 0 || orderId === null || !orderId.ok || sellerId === null || !sellerId.ok) {
    return err({ code: 'validation.failed', fields });
  }
  const { market } = context;
  const find = async () => {
    const order = await deps.orders.findOwn(market, orderId.value, accountId);
    return order?.status === 'confirmed'
      ? (order.sellerOrders.find((seller) => seller.sellerId === sellerId.value) ?? null)
      : null;
  };
  const first = await deps.unitOfWork.run<SellerOrder | null, PickupFailure>(
    market,
    async () => ok(await find()),
    { readOnly: true },
  );
  if (!first.ok) return first;
  if (first.value === null) return err({ code: 'ordering.order-not-found' });
  if (!awaitsHandover(first.value)) return err({ code: 'ordering.fulfilment-conflict' });
  // The code is made outside the unit: it uses the buyer's key.
  const sellerOrderId = first.value.id;
  const issued = await deps.pickupVault.issue(market, accountId, sellerOrderId);
  if (!issued.ok) return err({ code: 'ordering.fulfilment-conflict' });
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<PickupStatus, PickupFailure>(market, async () => {
    const fresh = await find();
    if (fresh === null) return err({ code: 'ordering.order-not-found' } as const);
    if (!awaitsHandover(fresh)) return err({ code: 'ordering.fulfilment-conflict' } as const);
    const record: PickupCodeRecord = {
      sellerOrderId: fresh.id,
      hash: issued.value.hash,
      sealed: issued.value.sealed,
      failedAttempts: 0,
      lockedAt: null,
      issuedAt: now,
    };
    // A ready pickup order always has a code; one that lost its row is given a new one.
    const written =
      (await deps.pickupCodes.replace(market, record)) ||
      (await deps.pickupCodes.insert(market, record));
    return written
      ? ok(pickupStatusOf(record))
      : err({ code: 'ordering.fulfilment-conflict' } as const);
  });
  logger.log({
    msg: 'ordering.pickup-code-regenerated',
    outcome: done.ok ? 'regenerated' : done.error.code,
    sellerOrderId,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  if (!done.ok) return done;
  return ok({ sellerId: sellerId.value, code: issued.value.code, ...done.value });
}
