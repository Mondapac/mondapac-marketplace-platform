import { err, money, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import {
  disputeStateChanged,
  isDisputeStatus,
  isInquiry,
  mergeDisputeState,
  reasonOf,
  type DisputeOutcome,
  type DisputeReason,
  type DisputeStatus,
} from '../domain/dispute';
import { DisputeChanged } from '../domain/events';
import type { PaymentsDependencies } from './payments-dependencies';
import type { DisputeRecord } from './ports/dispute-store';
import type { EventOutcome, PendingEvent } from './ports/stripe-event-inbox';

/** At most this many ids per `disputeOf` call. */
export const MAX_DISPUTE_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[a-z]{3}$/;

type Applied = EventOutcome | 'retry';

/**
 * A dispute event: the dispute is read again from Stripe with its PaymentIntent, which ordering
 * created with the order id and the Market in its metadata. A test-mode dispute of this Market's
 * order is stored once by its Stripe id, and each change of what payments keeps raises the
 * version and writes one `payments.dispute-changed.v1` in the same unit. An inquiry is stored the
 * same way and moves no money; nothing here moves money at all (package 8b acts on the event).
 */
export async function applyDisputeEvent(
  deps: PaymentsDependencies,
  context: CallContext,
  event: PendingEvent,
): Promise<Applied> {
  const market = context.market;
  const readAt = deps.clock.now();
  const read = await deps.disputeReader.readDispute(event.objectId);
  if (!read.ok) return read.error.code === 'payment.provider-unavailable' ? 'retry' : 'rejected';
  const dispute = read.value;
  if (dispute.id !== event.objectId || dispute.livemode !== false) return 'rejected';
  const intent = dispute.paymentIntent;
  // A dispute of a charge that no Checkout of this platform created names no Market: an admin
  // must look at it in the Stripe Dashboard.
  if (intent === null || intent.metadataMarketId === null) return 'rejected';
  if (intent.metadataMarketId !== market.marketId) return 'other-market';
  const orderId = intent.metadataOrderId;
  if (
    orderId === null ||
    !UUID.test(orderId) ||
    !isDisputeStatus(dispute.status) ||
    !CURRENCY.test(dispute.currency) ||
    dispute.amount <= 0n
  ) {
    return 'rejected';
  }
  const currency = dispute.currency.toUpperCase();
  const readState = {
    status: dispute.status,
    reason: reasonOf(dispute.reason),
    evidenceDueBy: dispute.evidenceDueBy,
    fundsWithdrawn: dispute.fundsWithdrawn,
    fundsReinstated: dispute.fundsReinstated,
  };

  const stored = await deps.unitOfWork.run<Applied, { readonly code: 'conflict' }>(
    market,
    async () => {
      const row = await deps.disputes.findByRef(market, dispute.id);
      if (row === null) {
        const id = deps.ids.next<'Dispute'>();
        const record: DisputeRecord = {
          id,
          providerDisputeId: dispute.id,
          orderId,
          paymentIntentRef: intent.id,
          amountMinor: dispute.amount,
          currency,
          openedAt: dispute.openedAt,
          ...mergeDisputeState(null, readState, readAt),
          createdAt: readAt,
          updatedAt: readAt,
          lastReadAt: readAt,
          version: 1,
        };
        // Another run stored it first: the event is read and applied again.
        if ((await deps.disputes.insert(market, record)) === 'conflict') {
          return err({ code: 'conflict' });
        }
        await appendChanged(deps, context, record.id, orderId, 1, readAt);
        return ok('dispute-recorded');
      }
      // What a dispute is about never changes: a different answer is refused, not stored.
      if (
        row.orderId !== orderId ||
        row.paymentIntentRef !== intent.id ||
        row.amountMinor !== dispute.amount ||
        row.currency !== currency
      ) {
        return ok('rejected');
      }
      // A read older than the stored one changes nothing.
      if (row.lastReadAt.epochMilliseconds > readAt.epochMilliseconds) return ok('ignored');
      const next = mergeDisputeState(row, readState, readAt);
      if (!disputeStateChanged(row, next)) return ok('ignored');
      if (!(await deps.disputes.update(market, row.id, row.version, next, readAt))) {
        return err({ code: 'conflict' });
      }
      await appendChanged(deps, context, row.id, row.orderId, row.version + 1, readAt);
      return ok('dispute-recorded');
    },
  );
  return stored.ok ? stored.value : 'retry';
}

function appendChanged(
  deps: PaymentsDependencies,
  context: CallContext,
  disputeId: string,
  orderId: string,
  version: number,
  at: Temporal.Instant,
): Promise<void> {
  // Both ids are UUIDs: the dispute's from the id generator, the order's checked by the caller.
  const aggregateId = disputeId as Id<'Dispute'>;
  return deps.outbox.append(context, [
    DisputeChanged.record({
      aggregateId,
      aggregateVersion: version,
      occurredAt: at,
      payload: { disputeId: aggregateId, orderId: orderId as Id<'Order'> },
    }),
  ]);
}

/** A dispute as other modules read it: ids, amount, state and deadline; no buyer or card data. */
export interface DisputeView {
  readonly disputeId: string;
  readonly orderId: string;
  /** Stripe's dispute id, for the Stripe Dashboard link (decision 6). */
  readonly providerDisputeId: string;
  readonly amount: Money;
  readonly status: DisputeStatus;
  readonly reason: DisputeReason;
  /** An inquiry: no money is withdrawn while it stays one. */
  readonly inquiry: boolean;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly fundsWithdrawn: boolean;
  readonly fundsWithdrawnAt: Temporal.Instant | null;
  readonly fundsReinstated: boolean;
  readonly fundsReinstatedAt: Temporal.Instant | null;
  readonly outcome: DisputeOutcome | null;
  readonly openedAt: Temporal.Instant;
  /** The version of the latest `dispute-changed` event of this dispute. */
  readonly version: number;
}

export type DisputeOfFailure = AccessDenied | { readonly code: 'validation.failed' };

/**
 * `payments.dispute-of`: the stored disputes of up to 100 ids of this Market, from stored state
 * only (no call to Stripe). An unknown id, or one of another Market, is left out.
 */
export async function disputeOf(
  deps: PaymentsDependencies,
  context: CallContext,
  disputeIds: readonly string[],
): Promise<Result<readonly DisputeView[], DisputeOfFailure>> {
  const given: unknown = disputeIds;
  if (
    !Array.isArray(given) ||
    given.length > MAX_DISPUTE_IDS ||
    !given.every((id: unknown) => typeof id === 'string' && UUID.test(id))
  ) {
    return err({ code: 'validation.failed' });
  }
  return deps.unitOfWork.run<readonly DisputeView[], DisputeOfFailure>(
    context.market,
    async () => {
      const rows = await deps.disputes.findMany(context.market, disputeIds);
      return ok(rows.map(toView));
    },
    { readOnly: true },
  );
}

const toView = (row: DisputeRecord): DisputeView => ({
  disputeId: row.id,
  orderId: row.orderId,
  providerDisputeId: row.providerDisputeId,
  amount: money(row.amountMinor, row.currency),
  status: row.status,
  reason: row.reason,
  inquiry: isInquiry(row.status),
  evidenceDueBy: row.evidenceDueBy,
  fundsWithdrawn: row.fundsWithdrawn,
  fundsWithdrawnAt: row.fundsWithdrawnAt,
  fundsReinstated: row.fundsReinstated,
  fundsReinstatedAt: row.fundsReinstatedAt,
  outcome: row.outcome,
  openedAt: row.openedAt,
  version: row.version,
});
