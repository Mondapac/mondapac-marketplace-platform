import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { PayoutHoldPlaced, PayoutHoldReleased } from '../domain/audit';
import { SellerReinstatedHoldRemains } from '../domain/events';
import {
  ADMIN_HOLD_REASONS,
  RELEASE_REASONS,
  type AdminHoldReason,
  type ReleaseReason,
} from '../domain/payout-hold';
import {
  COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE,
  COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE,
} from '../contracts/permissions';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import { spendStepUp, type StepUpFailure } from './step-up';
import type { PayoutHoldRecord } from './ports/payout-hold.repository';
import { sellerIdOf } from './rate-flow';

// Payout holds (package 6b; G2 3.5): an admin places and releases holds (protected keys); the
// system places a `seller-suspended` hold from identity's event and never releases it. A hold is
// inserted and released, never edited or deleted (a database trigger also refuses it).

export type HoldFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** Unknown, or another Market's, seller: byte-identical. */
  | { readonly code: 'commission-payouts.seller-not-found' }
  /** The seller order has no ledger rows for this seller in the Market. */
  | { readonly code: 'commission-payouts.seller-order-not-found' }
  /** Unknown, or another Market's, hold: byte-identical. */
  | { readonly code: 'commission-payouts.hold-not-found' }
  | { readonly code: 'commission-payouts.hold-already-released' }
  | { readonly code: 'commission-payouts.unavailable' }
  | StepUpFailure;

export interface PayoutHoldView {
  readonly holdId: Id<'PayoutHold'>;
  readonly sellerId: Id<'Seller'>;
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  readonly reason: PayoutHoldRecord['reason'];
  readonly origin: PayoutHoldRecord['origin'];
  readonly placedAt: PayoutHoldRecord['placedAt'];
  readonly active: boolean;
  readonly releasedAt: PayoutHoldRecord['releasedAt'];
  readonly releaseReason: PayoutHoldRecord['releaseReason'];
}

const viewOf = (hold: PayoutHoldRecord): PayoutHoldView => ({
  holdId: hold.id,
  sellerId: hold.sellerId,
  sellerOrderId: hold.sellerOrderId,
  reason: hold.reason,
  origin: hold.origin,
  placedAt: hold.placedAt,
  active: hold.releasedAt === null,
  releasedAt: hold.releasedAt,
  releaseReason: hold.releaseReason,
});

const adminOf = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin'
    ? context.actor
    : null;

/** An admin places a hold on a seller, or on one of its seller orders. */
export async function placePayoutHold(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: {
    readonly sellerId: unknown;
    readonly sellerOrderId?: unknown;
    readonly reason: unknown;
  },
): Promise<Result<PayoutHoldView, HoldFailure>> {
  const actor = adminOf(context);
  if (actor === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) fields.push({ path: 'sellerId', code: 'format' });
  let sellerOrderId: Id<'SellerOrder'> | null = null;
  if (input?.sellerOrderId !== undefined && input.sellerOrderId !== null) {
    const parsed =
      typeof input.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
    if (parsed !== null && parsed.ok) sellerOrderId = parsed.value;
    else fields.push({ path: 'sellerOrderId', code: 'format' });
  }
  const reason = input?.reason as AdminHoldReason;
  if (!ADMIN_HOLD_REASONS.includes(reason)) fields.push({ path: 'reason', code: 'format' });
  if (sellerId === null || fields.length > 0) return err({ code: 'validation.failed', fields });

  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'commission-payouts.unavailable' });
  if (!known) return err({ code: 'commission-payouts.seller-not-found' });

  const now = deps.clock.now();
  return deps.unitOfWork.run<PayoutHoldView, HoldFailure>(context.market, async () => {
    // The seller's money lock first (a payout and a hold placement run one after the other).
    await deps.cursors.lock(context.market, sellerId);
    if (sellerOrderId !== null) {
      // The seller order is checked against this module's own ledger of the context's Market.
      const owner = await deps.ledger.sellerOfSellerOrder(context.market, sellerOrderId);
      if (owner !== sellerId) {
        return err({ code: 'commission-payouts.seller-order-not-found' } as const);
      }
    }
    const spent = await spendStepUp(deps, context, COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE.key);
    if (!spent.ok) return err(spent.error);
    const id = deps.ids.next<'PayoutHold'>();
    const hold: PayoutHoldRecord = {
      id,
      sellerId,
      sellerOrderId,
      reason,
      origin: 'admin',
      // An admin hold's source is the hold itself.
      sourceRef: id,
      placedBy: actor.accountId,
      placedAt: now,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
    };
    await deps.holds.insertIfAbsent(context.market, hold);
    await deps.audit.record(
      context,
      PayoutHoldPlaced.entry(id, {
        after: { sellerId, sellerOrderId, reason, sourceRef: id },
      }),
    );
    return ok(viewOf(hold));
  });
}

/** An admin releases any hold, a `seller-suspended` one included, with a reason code. */
export async function releasePayoutHold(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly holdId: unknown; readonly reason: unknown },
): Promise<Result<PayoutHoldView, HoldFailure>> {
  const actor = adminOf(context);
  if (actor === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  const holdId = typeof input?.holdId === 'string' ? parseId<'PayoutHold'>(input.holdId) : null;
  if (holdId === null || !holdId.ok) fields.push({ path: 'holdId', code: 'format' });
  const reason = input?.reason as ReleaseReason;
  if (!RELEASE_REASONS.includes(reason)) fields.push({ path: 'reason', code: 'format' });
  if (holdId === null || !holdId.ok || fields.length > 0) {
    return err({ code: 'validation.failed', fields });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<PayoutHoldView, HoldFailure>(context.market, async () => {
    const hold = await deps.holds.find(context.market, holdId.value);
    if (hold === null) return err({ code: 'commission-payouts.hold-not-found' } as const);
    if (hold.releasedAt !== null) {
      return err({ code: 'commission-payouts.hold-already-released' } as const);
    }
    const spent = await spendStepUp(deps, context, COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key);
    if (!spent.ok) return err(spent.error);
    const released = await deps.holds.release(context.market, holdId.value, {
      releasedAt: now,
      releasedBy: actor.accountId,
      reason,
    });
    if (!released) return err({ code: 'commission-payouts.hold-already-released' } as const);
    await deps.audit.record(
      context,
      PayoutHoldReleased.entry(hold.id, {
        before: { sellerId: hold.sellerId, sellerOrderId: hold.sellerOrderId, reason: hold.reason },
        after: { releaseReason: reason },
      }),
    );
    return ok(
      viewOf({ ...hold, releasedAt: now, releasedBy: actor.accountId, releaseReason: reason }),
    );
  });
}

const HOLD_LIST_LIMIT = 100;

/** An admin lists a seller's holds, active ones first (the ids a release needs). */
export async function listPayoutHolds(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<readonly PayoutHoldView[], HoldFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'commission-payouts.unavailable' });
  if (!known) return err({ code: 'commission-payouts.seller-not-found' });
  return deps.unitOfWork.run<readonly PayoutHoldView[], HoldFailure>(
    context.market,
    async () =>
      ok(
        (
          await deps.holds.listForSeller(context.market, sellerId, {
            activeOnly: false,
            limit: HOLD_LIST_LIMIT,
          })
        ).map(viewOf),
      ),
    { readOnly: true },
  );
}

export type HoldEventFailure =
  { readonly code: 'validation.failed' } | { readonly code: 'commission-payouts.try-again' };

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/**
 * `identity.seller-access-suspended.v1`: places a system `seller-suspended` hold on the whole
 * seller, once per decision (the inbox row and the unique (reason, source) key both stop a
 * repeat). Nothing in this module ever releases it by itself.
 */
export async function placeSellerSuspendedHold(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly sellerId: unknown;
    readonly decisionId: unknown;
  },
): Promise<Result<'placed' | 'already-placed', HoldEventFailure>> {
  const sellerId = idOf<'Seller'>(input?.sellerId);
  const decisionId = idOf<'SellerAccessDecision'>(input?.decisionId);
  if (sellerId === null || decisionId === null) return err({ code: 'validation.failed' });
  const now = deps.clock.now();
  const done = await deps.unitOfWork.runOnce<'placed' | 'already-placed', HoldEventFailure>(
    context.market,
    input.delivery,
    async () => {
      await deps.cursors.lock(context.market, sellerId);
      const id = deps.ids.next<'PayoutHold'>();
      const placed = await deps.holds.insertIfAbsent(context.market, {
        id,
        sellerId,
        sellerOrderId: null,
        reason: 'seller-suspended',
        origin: 'system',
        sourceRef: decisionId,
        placedBy: null,
        placedAt: now,
        releasedAt: null,
        releasedBy: null,
        releaseReason: null,
      });
      if (placed) {
        await deps.audit.record(
          context,
          PayoutHoldPlaced.entry(id, {
            after: {
              sellerId,
              sellerOrderId: null,
              reason: 'seller-suspended',
              sourceRef: decisionId,
            },
          }),
        );
      }
      return ok(placed ? ('placed' as const) : ('already-placed' as const));
    },
  );
  if (!done.ok) return done;
  return ok(done.value.handled ? done.value.value : 'already-placed');
}

/**
 * `identity.seller-access-reinstated.v1`: releases nothing. The hold stays until an admin decides;
 * the only effect is an admin notice, sent through notifications (an event with ids only) when a
 * `seller-suspended` hold remains.
 */
export async function noteSellerReinstated(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly sellerId: unknown;
    readonly decisionId: unknown;
  },
): Promise<Result<'noted' | 'already-noted', HoldEventFailure>> {
  const sellerId = idOf<'Seller'>(input?.sellerId);
  const decisionId = idOf<'SellerAccessDecision'>(input?.decisionId);
  if (sellerId === null || decisionId === null) return err({ code: 'validation.failed' });
  const now = deps.clock.now();
  const done = await deps.unitOfWork.runOnce<'noted', HoldEventFailure>(
    context.market,
    input.delivery,
    async () => {
      const holds = await deps.holds.listForSeller(context.market, sellerId, {
        activeOnly: true,
        limit: HOLD_LIST_LIMIT,
      });
      if (holds.some((hold) => hold.reason === 'seller-suspended')) {
        await deps.outbox.append(context, [
          SellerReinstatedHoldRemains.record({
            aggregateId: decisionId,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { decisionId, sellerId },
          }),
        ]);
      }
      return ok('noted' as const);
    },
  );
  if (!done.ok) return done;
  return ok(done.value.handled ? 'noted' : 'already-noted');
}
