import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { PayoutAlert } from '../../../platform/security-events/security-event-catalogue';
import { moveTo, type Payout } from '../domain/payout';
import type { PayoutDependencies } from './payout-dependencies';
import { sendWithRecheck } from './payout-run-flow';
import type { TransferLookup } from './ports/payout-gateways';

// Settling the payouts payments has been asked to pay (package 6d; G2 3.6, 11). The money left
// the platform when payments created the transfer; what is left to learn is whether it was ever
// created (INSTRUCTING), and whether it arrived (INSTRUCTED). payments never re-sends: an unknown
// answer is asked again by key, and after `transferSendTimeout` the key is fenced with
// `abandonTransfer`; a fenced key waits out a quarantine and is asked once more before the payout
// is closed as NOT_SENT. The event `payments.transfer-changed.v1` is only a trigger: the state is
// read by key.

const logger = new Logger('CommissionPayoutsReconcile');

const BATCH_SIZE = 100;
/** The least time between the fence and the second `abandonTransfer` (design 3.6, HP-4 fix 5). */
export const TRANSFER_ABANDON_QUARANTINE = Temporal.Duration.from({ minutes: 15 });
/** `transferSendTimeout` is at least twice payments' send lease (HP-4 fix 3). */
const SEND_TIMEOUT_LEASES = 2;

export interface ReconcileSummary {
  readonly asked: number;
  readonly paid: number;
  readonly failed: number;
  readonly instructed: number;
  readonly notSent: number;
  readonly fenced: number;
  readonly waiting: number;
}

type Stale = { readonly code: 'stale' };

class Counts {
  asked = 0;
  paid = 0;
  failed = 0;
  instructed = 0;
  notSent = 0;
  fenced = 0;
  waiting = 0;
}

type Settlement =
  | { readonly kind: 'executed'; readonly transferExecutionId: string }
  | { readonly kind: 'failed'; readonly transferExecutionId: string | null }
  | { readonly kind: 'sent'; readonly transferExecutionId: string }
  | { readonly kind: 'not-sent'; readonly code: string }
  | { readonly kind: 'fenced' };

/**
 * Applies what is now known about a payout's transfer, inside the caller's open unit and under the
 * seller's cursor lock. Answers the state the payout ended in, or `stale` when it moved meanwhile.
 */
async function settleInUnit(
  deps: PayoutDependencies,
  market: MarketContext,
  payoutId: Id<'Payout'>,
  settlement: Settlement,
  now: Temporal.Instant,
): Promise<Result<Payout['state'], Stale>> {
  const first = await deps.payouts.find(market, payoutId);
  if (first === null) return err({ code: 'stale' } as const);
  const locked = await deps.cursors.lock(market, first.sellerId);
  const current = await deps.payouts.find(market, payoutId);
  if (locked === null || current === null) return err({ code: 'stale' } as const);

  let payout = current;
  const step = async (next: Payout): Promise<boolean> => {
    if (!(await deps.payouts.change(market, payout, next))) return false;
    payout = next;
    return true;
  };
  switch (settlement.kind) {
    case 'executed':
    case 'failed':
    case 'sent': {
      if (payout.state === 'instructing') {
        const id = settlement.transferExecutionId;
        if (id === null) return err({ code: 'stale' } as const);
        if (!(await step(moveTo(payout, 'instructed', now, { transferExecutionId: id })))) {
          return err({ code: 'stale' } as const);
        }
      }
      if (payout.state === 'instructed' && settlement.kind === 'executed') {
        if (!(await step(moveTo(payout, 'paid', now)))) return err({ code: 'stale' } as const);
      } else if (payout.state === 'instructed' && settlement.kind === 'failed') {
        if (!(await step(moveTo(payout, 'failed', now, { outcomeCode: 'transfer-failed' })))) {
          return err({ code: 'stale' } as const);
        }
      }
      return ok(payout.state);
    }
    case 'not-sent': {
      if (payout.state !== 'instructing') return ok(payout.state);
      if (!(await step(moveTo(payout, 'not-sent', now, { outcomeCode: settlement.code })))) {
        return err({ code: 'stale' } as const);
      }
      return ok(payout.state);
    }
    case 'fenced': {
      // The key is fenced at payments; the payout stays INSTRUCTING and its items stay taken
      // until the quarantine pass closes it.
      if (payout.state !== 'instructing' || payout.abandonedAt !== null) return ok(payout.state);
      const next: Payout = {
        ...payout,
        abandonedAt: now,
        version: payout.version + 1,
      };
      if (!(await step(next))) return err({ code: 'stale' } as const);
      return ok(payout.state);
    }
  }
}

async function settle(
  deps: PayoutDependencies,
  context: CallContext,
  payout: Payout,
  settlement: Settlement,
): Promise<Payout['state'] | null> {
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run(context.market, () =>
    settleInUnit(deps, context.market, payout.id, settlement, now),
  );
  return done.ok ? done.value : null;
}

/** `commission-payouts.reconcile-instructions`: one pass of the 5-minute job for the context's Market. */
export async function reconcileInstructions(
  deps: PayoutDependencies,
  context: CallContext,
): Promise<Result<ReconcileSummary, never>> {
  const market = context.market;
  const counts = new Counts();
  const limits = deps.payoutPolicy.limits(market);
  if (limits === null) return ok(summaryOf(counts));
  const sendTimeout = Temporal.Duration.from({
    seconds: SEND_TIMEOUT_LEASES * limits.sendLeaseSeconds,
  });

  const open = await deps.unitOfWork.run(
    market,
    async () =>
      ok(await deps.payouts.listByState(market, ['instructing', 'instructed'], BATCH_SIZE)),
    { readOnly: true },
  );
  if (!open.ok || open.value.length === 0) return ok(summaryOf(counts));
  const lookups = await deps.payments.lookup(
    context,
    open.value.map((payout) => payout.id),
  );
  if (lookups === 'unavailable') {
    counts.waiting += open.value.length;
    return ok(summaryOf(counts));
  }
  const byKey = new Map(lookups.map((lookup) => [lookup.instructionKey, lookup]));
  counts.asked = open.value.length;

  for (const payout of open.value) {
    const lookup = byKey.get(payout.id);
    if (lookup === undefined) {
      counts.waiting += 1;
      continue;
    }
    await reconcileOne(deps, context, payout, lookup, sendTimeout, counts);
  }
  const summary = summaryOf(counts);
  if (summary.asked > 0) {
    logger.log({
      msg: 'commission-payouts.reconcile-instructions',
      marketId: market.marketId,
      correlationId: context.correlationId,
      ...summary,
    });
  }
  return ok(summary);
}

const summaryOf = (counts: Counts): ReconcileSummary => ({ ...counts });

async function reconcileOne(
  deps: PayoutDependencies,
  context: CallContext,
  payout: Payout,
  lookup: TransferLookup,
  sendTimeout: Temporal.Duration,
  counts: Counts,
): Promise<void> {
  const now = deps.clock.now();
  const executionId = lookup.transferExecutionId;
  if (lookup.state === 'executed' && executionId !== null) {
    const state = await settle(deps, context, payout, {
      kind: 'executed',
      transferExecutionId: executionId,
    });
    if (state === 'paid') counts.paid += 1;
    return;
  }
  if (lookup.state === 'failed') {
    const state = await settle(deps, context, payout, {
      kind: 'failed',
      transferExecutionId: executionId ?? payout.transferExecutionId,
    });
    if (state === 'failed') counts.failed += 1;
    return;
  }
  if (payout.state !== 'instructing') {
    counts.waiting += 1;
    return;
  }
  if (lookup.state === 'refused') {
    const state = await settle(deps, context, payout, {
      kind: 'not-sent',
      code: 'transfer-refused',
    });
    if (state === 'not-sent') counts.notSent += 1;
    return;
  }
  const since = payout.instructingAt ?? payout.stateChangedAt;
  const timedOut = Temporal.Instant.compare(since.add(sendTimeout), now) <= 0;

  // A fenced key waits out the quarantine, then is asked once more.
  if (payout.abandonedAt !== null || lookup.state === 'abandoned') {
    if (payout.abandonedAt === null) {
      await settle(deps, context, payout, { kind: 'fenced' });
      counts.fenced += 1;
      return;
    }
    if (Temporal.Instant.compare(payout.abandonedAt.add(TRANSFER_ABANDON_QUARANTINE), now) > 0) {
      counts.waiting += 1;
      return;
    }
    const answer = await deps.payments.abandon(context, payout.id);
    if (answer === 'unavailable' || answer.kind === 'in-flight' || answer.kind === 'abandoned') {
      counts.waiting += 1;
    } else if (answer.kind === 'already-sent') {
      await settle(deps, context, payout, {
        kind: 'sent',
        transferExecutionId: answer.transferExecutionId,
      });
      counts.instructed += 1;
    } else {
      const state = await settle(deps, context, payout, {
        kind: 'not-sent',
        code: 'payout-unwound',
      });
      if (state === 'not-sent') counts.notSent += 1;
    }
    return;
  }

  if (lookup.state === 'none' && !timedOut) {
    // payments never saw the key: the first call is still ours to make.
    const result = await sendWithRecheck(deps, context, payout, null);
    if (result === 'instructed') counts.instructed += 1;
    else if (result === 'not-sent') counts.notSent += 1;
    else counts.waiting += 1;
    return;
  }
  if (!timedOut) {
    counts.waiting += 1;
    return;
  }
  // Past the timeout and still not known to have been sent: fence the key.
  const answer = await deps.payments.abandon(context, payout.id);
  if (answer === 'unavailable' || answer.kind === 'in-flight') {
    counts.waiting += 1;
  } else if (answer.kind === 'already-sent') {
    await settle(deps, context, payout, {
      kind: 'sent',
      transferExecutionId: answer.transferExecutionId,
    });
    counts.instructed += 1;
  } else {
    await settle(deps, context, payout, { kind: 'fenced' });
    counts.fenced += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The consumer of payments.transfer-changed.v1

export type TransferEventFailure =
  { readonly code: 'validation.failed' } | { readonly code: 'commission-payouts.try-again' };

export type TransferEventOutcome = 'paid' | 'failed' | 'unchanged' | 'alerted' | 'already-handled';

/**
 * `payments.transfer-changed.v1`: a trigger only. The payout the transfer belongs to is found by
 * the transfer id, its state is read by key, and the payout follows it (executed: PAID; failed:
 * FAILED). A transfer no payout owns yet may be one whose acceptance is still committing, so the
 * delivery is retried; the reconcile job closes the gap if it never matches.
 */
export async function applyTransferChange(
  deps: PayoutDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly transferExecutionId: unknown;
    readonly sellerId: unknown;
  },
): Promise<Result<TransferEventOutcome, TransferEventFailure>> {
  const executionId =
    typeof input?.transferExecutionId === 'string'
      ? parseId<'TransferExecution'>(input.transferExecutionId)
      : null;
  if (executionId === null || !executionId.ok) return err({ code: 'validation.failed' });
  const market = context.market;

  const found = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.payouts.findByTransferExecution(market, executionId.value)),
    { readOnly: true },
  );
  if (!found.ok) return err({ code: 'commission-payouts.try-again' });
  const payout = found.value;
  if (payout === null) return err({ code: 'commission-payouts.try-again' });

  const lookups = await deps.payments.lookup(context, [payout.id]);
  if (lookups === 'unavailable') return err({ code: 'commission-payouts.try-again' });
  const lookup = lookups.find((candidate) => candidate.instructionKey === payout.id);
  if (lookup === undefined) return err({ code: 'commission-payouts.try-again' });
  if (lookup.transferExecutionId !== null && lookup.transferExecutionId !== executionId.value) {
    // The transfer the event names is not the one payments holds for this payout's key.
    return alertUnmatched(deps, context, input.delivery, payout);
  }

  const settlement: Settlement | null =
    lookup.state === 'executed' && lookup.transferExecutionId !== null
      ? { kind: 'executed', transferExecutionId: lookup.transferExecutionId }
      : lookup.state === 'failed'
        ? { kind: 'failed', transferExecutionId: payout.transferExecutionId }
        : null;
  const now = deps.clock.now();
  const done = await deps.unitOfWork.runOnce<TransferEventOutcome, TransferEventFailure>(
    market,
    input.delivery,
    async () => {
      if (settlement === null) return ok('unchanged' as const);
      const settled = await settleInUnit(deps, market, payout.id, settlement, now);
      if (!settled.ok) return err({ code: 'commission-payouts.try-again' } as const);
      return ok(
        settled.value === 'paid'
          ? ('paid' as const)
          : settled.value === 'failed'
            ? ('failed' as const)
            : ('unchanged' as const),
      );
    },
  );
  if (!done.ok) return done;
  return ok(done.value.handled ? done.value.value : 'already-handled');
}

async function alertUnmatched(
  deps: PayoutDependencies,
  context: CallContext,
  delivery: EventDelivery,
  payout: Payout,
): Promise<Result<TransferEventOutcome, TransferEventFailure>> {
  const done = await deps.unitOfWork.runOnce<TransferEventOutcome, TransferEventFailure>(
    context.market,
    delivery,
    async () => {
      await deps.securityEvents.record(
        context,
        PayoutAlert.event({ payload: { sellerId: payout.sellerId, reason: 'transfer-unmatched' } }),
      );
      return ok('alerted' as const);
    },
  );
  if (!done.ok) return done;
  return ok(done.value.handled ? done.value.value : 'already-handled');
}
