import { err, money, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import { RefundLimitRemoved, RefundLimitSet } from '../domain/audit';
import {
  limitInForce,
  parseRefundLimitInput,
  parseSellerId,
  parseVersion,
  type RefundLimit,
} from '../domain/refund-limits';
import { isActingAsSession } from './acting-as';
import type { OrderingDependencies } from './checkout-flow';

// An admin's caps on seller refunds (order detail decision 6; Hassan F2; owner decision
// 2026-11-11): the Market's default and any seller's own, read with `ordering.refund-limits.view`
// and set or removed with `ordering.refund-limits.manage` (protected). Every change is audited
// with the values before and after; a stale edit (another admin changed it first) is refused.

/** One cap as the admin panel shows it. */
export interface RefundLimitView {
  readonly maxCount: number;
  readonly maxAmount: Money;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: Id<'Account'>;
}

/** The Market default, and (when a seller was named) that seller's own and which is in force. */
export interface RefundLimitsView {
  readonly currency: string;
  readonly marketDefault: RefundLimitView | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly own: RefundLimitView | null;
  /** `own`, `market`, or `none` (no cap: the seller path is refused). */
  readonly inForce: 'own' | 'market' | 'none';
}

export type RefundLimitsFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** Another admin changed the cap since it was read: read again. */
  | { readonly code: 'conflict.retry' }
  /** The seller has no cap of its own to remove. */
  | { readonly code: 'ordering.refund-limit-not-found' };

function limitView(limit: RefundLimit | null): RefundLimitView | null {
  return limit === null
    ? null
    : {
        maxCount: limit.maxCount,
        maxAmount: limit.maxAmount,
        version: limit.version,
        updatedAt: limit.updatedAt.toString(),
        updatedBy: limit.updatedBy,
      };
}

function limitsView(
  deps: OrderingDependencies,
  context: CallContext,
  sellerId: Id<'Seller'> | null,
  own: RefundLimit | null,
  marketDefault: RefundLimit | null,
): RefundLimitsView {
  const inForce = limitInForce(own, marketDefault);
  return {
    currency: deps.policy.currency(context.market),
    marketDefault: limitView(marketDefault),
    sellerId,
    own: limitView(own),
    inForce: inForce === null ? 'none' : inForce === own ? 'own' : 'market',
  };
}

/** The caps of the Market, and of one seller when `sellerId` is given (a query parameter). */
export async function viewRefundLimits(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<RefundLimitsView, RefundLimitsFailure>> {
  const named = input?.sellerId;
  const sellerId = named === undefined || named === null ? null : parseSellerId(named);
  if (named !== undefined && named !== null && sellerId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  return deps.unitOfWork.run<RefundLimitsView, RefundLimitsFailure>(
    context.market,
    async () => {
      const limits = await deps.refunds.findRefundLimits(context.market, sellerId);
      return ok(limitsView(deps, context, sellerId, limits.own, limits.marketDefault));
    },
    { readOnly: true },
  );
}

/**
 * Sets the Market's default cap (`sellerId` null) or a seller's own. `expectedVersion` is the
 * version the admin read, 0 for a cap not set yet. The amount is in minor units of the Market
 * currency.
 */
export async function setRefundLimit(
  deps: OrderingDependencies,
  context: CallContext,
  input: {
    readonly sellerId: unknown;
    readonly maxCount: unknown;
    readonly maxAmount: unknown;
    readonly expectedVersion: unknown;
  },
): Promise<Result<RefundLimitsView, RefundLimitsFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAsSession(actor)) {
    return err({ code: 'access.denied' });
  }
  const named = input?.sellerId;
  const sellerId = named === null ? null : parseSellerId(named);
  const parsed = parseRefundLimitInput({
    maxCount: input?.maxCount,
    maxAmount: input?.maxAmount,
    expectedVersion: input?.expectedVersion,
  });
  const fields = [
    ...(named !== null && sellerId === null ? [{ path: 'sellerId', code: 'format' }] : []),
    ...(parsed.ok ? [] : parsed.fields),
  ];
  if (fields.length > 0 || !parsed.ok) return err({ code: 'validation.failed', fields });
  const { maxCount, maxAmount, expectedVersion } = parsed.value;
  const currency = deps.policy.currency(context.market);

  return deps.unitOfWork.run<RefundLimitsView, RefundLimitsFailure>(context.market, async () => {
    const limits = await deps.refunds.findRefundLimits(context.market, sellerId);
    const current = sellerId === null ? limits.marketDefault : limits.own;
    if ((current?.version ?? 0) !== expectedVersion)
      return err({ code: 'conflict.retry' } as const);
    const limit: RefundLimit = {
      id: current?.id ?? deps.ids.next<'SellerRefundLimit'>(),
      sellerId,
      maxCount,
      maxAmount: money(maxAmount, currency),
      version: expectedVersion + 1,
      updatedAt: deps.clock.now(),
      updatedBy: actor.accountId,
    };
    if ((await deps.refunds.saveRefundLimit(context.market, limit, expectedVersion)) === 'stale') {
      return err({ code: 'conflict.retry' } as const);
    }
    await deps.audit.record(
      context,
      RefundLimitSet.entry(limit.id, {
        before: { maxCount: current?.maxCount ?? null, maxAmount: current?.maxAmount ?? null },
        after: {
          maxCount,
          maxAmount: limit.maxAmount,
          scope: sellerId === null ? 'market' : 'seller',
          sellerId,
          version: limit.version,
        },
      }),
    );
    return ok(
      sellerId === null
        ? limitsView(deps, context, null, null, limit)
        : limitsView(deps, context, sellerId, limit, limits.marketDefault),
    );
  });
}

/** Removes a seller's own cap (the Market default is in force again) if it has that version. */
export async function removeRefundLimit(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly expectedVersion: unknown },
): Promise<Result<RefundLimitsView, RefundLimitsFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAsSession(actor)) {
    return err({ code: 'access.denied' });
  }
  const sellerId = parseSellerId(input?.sellerId);
  const version = parseVersion(input?.expectedVersion);
  const fields = [
    ...(sellerId === null ? [{ path: 'sellerId', code: 'format' }] : []),
    ...(version === null || version < 1 ? [{ path: 'expectedVersion', code: 'range' }] : []),
  ];
  if (fields.length > 0 || sellerId === null || version === null) {
    return err({ code: 'validation.failed', fields });
  }
  return deps.unitOfWork.run<RefundLimitsView, RefundLimitsFailure>(context.market, async () => {
    const limits = await deps.refunds.findRefundLimits(context.market, sellerId);
    if (limits.own === null) return err({ code: 'ordering.refund-limit-not-found' } as const);
    if (limits.own.version !== version) return err({ code: 'conflict.retry' } as const);
    if ((await deps.refunds.removeRefundLimit(context.market, sellerId, version)) === 'stale') {
      return err({ code: 'conflict.retry' } as const);
    }
    await deps.audit.record(
      context,
      RefundLimitRemoved.entry(limits.own.id, {
        before: { maxCount: limits.own.maxCount, maxAmount: limits.own.maxAmount, sellerId },
      }),
    );
    return ok(limitsView(deps, context, sellerId, null, limits.marketDefault));
  });
}
