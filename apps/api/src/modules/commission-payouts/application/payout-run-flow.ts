import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { PayoutAlert } from '../../../platform/security-events/security-event-catalogue';
import {
  blockReasonOfRefusal,
  moveTo,
  openPayout,
  type BlockReason,
  type Payout,
  type PayoutItem,
} from '../domain/payout';
import {
  isKnownZone,
  latestSlot,
  nextSlotAfter,
  type ScheduleTerms,
} from '../domain/payout-schedule';
import type { PayoutDependencies } from './payout-dependencies';
import {
  gateSeller,
  HOLDS_READ_LIMIT,
  planSeller,
  type GateAnswer,
  type SellerPlan,
} from './payout-planning';
import type { PayoutCursor } from './ports/payout-cursor.repository';

// The payout run (package 6d; G2 4.7). Every 15 minutes, for each hosted Market:
//   1. payouts waiting for an admin or approved are checked again (a hold or a changed amount
//      voids them; an approved one that still passes is instructed);
//   2. sellers whose slot has come (at most 100 per batch) are worked out: what is eligible, what
//      the receivable takes back, and a payout, a settlement by netting, or a reason not to pay;
//   3. after each commit, `instructTransfer` is called for the payouts that became INSTRUCTING.
// Nothing calls another module inside a unit. The planner reads in a read-only unit first; the
// write unit of a seller takes the cursor row lock before anything else, plans again and writes.

const logger = new Logger('CommissionPayoutsRun');

const BATCH_SIZE = 100;
/** Batches per run: a run never works for more than this many sellers (5 x 100). */
const MAX_BATCHES = 5;
/** A seller blocked by something that can clear is looked at again after this long. */
const RETRY_AFTER = Temporal.Duration.from({ hours: 1 });
/** A seller whose next slot could not be worked out is looked at again after this long. */
const REEVALUATE_AFTER = Temporal.Duration.from({ hours: 1 });
/** An approval that has waited this long is an alert (raised once, in the run that crosses it). */
export const APPROVAL_ALERT_AFTER = Temporal.Duration.from({ hours: 24 });
/** The cadence of the run; an alert is raised in the run whose window contains its instant. */
export const RUN_INTERVAL = Temporal.Duration.from({ minutes: 15 });

export interface RunSummary {
  readonly evaluated: number;
  readonly created: number;
  readonly settledByNetting: number;
  readonly voided: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly instructed: number;
  readonly notSent: number;
  readonly pendingAnswer: number;
  readonly alerts: number;
}

export type RunFailure = { readonly code: 'commission-payouts.terms-unavailable' };

export class Tally {
  evaluated = 0;
  created = 0;
  settledByNetting = 0;
  voided = 0;
  blocked = 0;
  skipped = 0;
  instructed = 0;
  notSent = 0;
  pendingAnswer = 0;
  alerts = 0;
  /** Payouts that became INSTRUCTING and still need `instructTransfer`. */
  summary(): RunSummary {
    return {
      evaluated: this.evaluated,
      created: this.created,
      settledByNetting: this.settledByNetting,
      voided: this.voided,
      blocked: this.blocked,
      skipped: this.skipped,
      instructed: this.instructed,
      notSent: this.notSent,
      pendingAnswer: this.pendingAnswer,
      alerts: this.alerts,
    };
  }
}

/** A unit found the world changed since the read: nothing was written, the next run decides. */
type Stale = { readonly code: 'stale' };

/**
 * `commission-payouts.run-payouts`: one pass of the worker for the context's Market. The scheduler
 * hands in its system-actor context; the use case's rule is `system`.
 */
export async function runPayouts(
  deps: PayoutDependencies,
  context: CallContext,
): Promise<Result<RunSummary, RunFailure>> {
  const tally = new Tally();
  const now = deps.clock.now();

  await revalidateWaiting(deps, context, tally, now);

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const due = await deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await deps.cursors.listDue(
            context.market,
            now,
            now.subtract(REEVALUATE_AFTER),
            BATCH_SIZE,
          ),
        ),
      { readOnly: true },
    );
    if (!due.ok || due.value.length === 0) break;
    for (const cursor of due.value) await evaluateSeller(deps, context, cursor, now, tally);
    if (due.value.length < BATCH_SIZE) break;
  }

  const summary = tally.summary();
  logger.log({
    msg: 'commission-payouts.payout-run',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
    ...summary,
  });
  return ok(summary);
}

// ---------------------------------------------------------------------------------------------
// One seller

async function evaluateSeller(
  deps: PayoutDependencies,
  context: CallContext,
  cursor: PayoutCursor,
  now: Temporal.Instant,
  tally: Tally,
): Promise<void> {
  const market = context.market;
  const sellerId = cursor.sellerId;
  tally.evaluated += 1;

  const settings = deps.policy.settings(market);
  const terms = await deps.unitOfWork.run(
    market,
    async () => {
      const resolved = await deps.terms.resolve(market, sellerId);
      return resolved.ok ? ok(resolved.value.terms) : resolved;
    },
    { readOnly: true },
  );
  if (!terms.ok || settings === null) {
    tally.skipped += 1;
    return;
  }

  // The zone is the seller's own approved operating zone: a missing or draft one means no payout
  // and an alert, never the Market's zone (ADR-0005).
  const zones = await deps.access.zones(context, [sellerId]);
  if (zones === 'unavailable') {
    tally.skipped += 1;
    return;
  }
  const found = zones.get(sellerId);
  if (found === undefined || found.provisional || !isKnownZone(found.zone)) {
    const alerted = await writeCursor(deps, context, cursor, now, {
      lastSlotAt: cursor.lastSlotAt,
      nextSlotAt: null,
      zone: null,
      blockReason: 'zone-missing',
      alert: true,
    });
    if (alerted) tally.alerts += 1;
    tally.blocked += 1;
    return;
  }
  const zone = found.zone;
  const schedule: ScheduleTerms = {
    weekdays: terms.value.weekdays,
    localTime: terms.value.localTime,
  };

  const slot = latestSlot(schedule, zone, cursor.lastSlotAt, now);
  if (slot === null) {
    // Nothing due: work out when the next slot is and look again then.
    await writeCursor(deps, context, cursor, now, {
      lastSlotAt: cursor.lastSlotAt,
      nextSlotAt: nextSlotAfter(schedule, zone, now),
      zone,
      blockReason: cursor.blockReason === 'zone-missing' ? null : cursor.blockReason,
    });
    return;
  }

  const holdOpen = async (blockReason: BlockReason | null): Promise<void> => {
    tally.blocked += blockReason === null ? 0 : 1;
    await writeCursor(deps, context, cursor, now, {
      lastSlotAt: cursor.lastSlotAt,
      nextSlotAt: now.add(RETRY_AFTER),
      zone,
      blockReason,
    });
  };
  const advance = async (blockReason: BlockReason | null): Promise<void> => {
    tally.blocked += blockReason === null ? 0 : 1;
    await writeCursor(deps, context, cursor, now, {
      lastSlotAt: slot,
      nextSlotAt: nextSlotAfter(schedule, zone, now),
      zone,
      blockReason,
    });
  };

  // The planner, outside the write unit. One live payout per seller: while one waits for an
  // approval or is on its way the next waits too (the slot stays open).
  const looked = await deps.unitOfWork.run<
    { readonly live: Payout | null; readonly plan: SellerPlan | null },
    never
  >(
    market,
    async () => {
      const live = await deps.payouts.findLive(market, sellerId);
      if (live !== null) return ok({ live, plan: null });
      const plan = await planSeller(
        deps,
        market,
        sellerId,
        settings.currency,
        terms.value.minimumMinor,
        now,
      );
      return ok({ live: null, plan });
    },
    { readOnly: true },
  );
  if (!looked.ok) return;
  if (looked.value.live !== null) {
    await holdOpen(looked.value.live.state === 'awaiting-approval' ? 'awaiting-approval' : null);
    return;
  }
  const plan = looked.value.plan!.plan;
  if (plan.sellerHeld) return holdOpen('payouts-paused');
  if (plan.eligible === 0n) return advance(null);

  let needsGate = false;
  if (plan.transfer > 0n) {
    if (plan.belowMinimum) return advance('below-minimum');
    needsGate = true;
    const gate = await gateSeller(deps, context, sellerId);
    if (gate.kind === 'unavailable') {
      tally.skipped += 1;
      return;
    }
    if (gate.kind === 'blocked') return holdOpen(gate.reason);
  }

  // The write unit: the cursor lock first, then the same plan again from the committed state.
  const created = await deps.unitOfWork.run<Payout, Stale>(market, async () => {
    const locked = await deps.cursors.lock(market, sellerId);
    if (locked === null || !locked.lastSlotAt.equals(cursor.lastSlotAt)) {
      return err({ code: 'stale' } as const);
    }
    if ((await deps.payouts.findLive(market, sellerId)) !== null) {
      return err({ code: 'stale' } as const);
    }
    const fresh = await planSeller(
      deps,
      market,
      sellerId,
      settings.currency,
      terms.value.minimumMinor,
      now,
    );
    const settles = fresh.plan.eligible > 0n && fresh.plan.transfer === 0n;
    const pays = fresh.plan.transfer > 0n && !fresh.plan.belowMinimum && needsGate;
    if (fresh.plan.sellerHeld || !(settles || pays)) return err({ code: 'stale' } as const);

    const payout = openPayout({
      id: deps.ids.next<'Payout'>(),
      sellerId,
      currency: settings.currency,
      items: fresh.items,
      netted: fresh.plan.netted,
      approvalMode: terms.value.approvalMode,
      firstPayout: terms.value.firstPayoutManual && !fresh.hasPaid,
      minimum: terms.value.minimumMinor,
      slotAt: slot,
      now,
    });
    await deps.payouts.insert(market, payout, fresh.items);
    await deps.cursors.save(
      market,
      sellerId,
      {
        lastSlotAt: slot,
        nextSlotAt: nextSlotAfter(schedule, zone, now),
        zone,
        blockReason: payout.state === 'awaiting-approval' ? 'awaiting-approval' : null,
        evaluatedAt: now,
      },
      now,
    );
    return ok(payout);
  });
  if (!created.ok) {
    tally.skipped += 1;
    return;
  }
  const payout = created.value;
  if (payout.state === 'settled-by-netting') tally.settledByNetting += 1;
  else tally.created += 1;
  // Sent now, not after the other sellers: the window between the checks and the send is the
  // re-check's own (design 4.7 step 5).
  if (payout.state === 'instructing') await sendWithRecheck(deps, context, payout, tally);
}

interface CursorWrite {
  readonly lastSlotAt: Temporal.Instant;
  readonly nextSlotAt: Temporal.Instant | null;
  readonly zone: string | null;
  readonly blockReason: BlockReason | null;
  readonly alert?: boolean;
}

/**
 * Writes the cursor of a seller under its lock, unless it moved since the run read it. Answers
 * whether an alert was raised (a zone that is still missing alerts once, on the change).
 */
async function writeCursor(
  deps: PayoutDependencies,
  context: CallContext,
  read: PayoutCursor,
  now: Temporal.Instant,
  write: CursorWrite,
): Promise<boolean> {
  const market = context.market;
  const done = await deps.unitOfWork.run<boolean, Stale>(market, async () => {
    const locked = await deps.cursors.lock(market, read.sellerId);
    if (locked === null || !locked.lastSlotAt.equals(read.lastSlotAt)) {
      return err({ code: 'stale' } as const);
    }
    await deps.cursors.save(
      market,
      read.sellerId,
      {
        lastSlotAt: write.lastSlotAt,
        nextSlotAt: write.nextSlotAt,
        zone: write.zone,
        blockReason: write.blockReason,
        evaluatedAt: now,
      },
      now,
    );
    const raise = write.alert === true && locked.blockReason !== 'zone-missing';
    if (raise) {
      await deps.securityEvents.record(
        context,
        PayoutAlert.event({ payload: { sellerId: read.sellerId, reason: 'zone-missing' } }),
      );
    }
    return ok(raise);
  });
  return done.ok && done.value;
}

// ---------------------------------------------------------------------------------------------
// Payouts that wait: an admin's approval, then the checks at execution

async function revalidateWaiting(
  deps: PayoutDependencies,
  context: CallContext,
  tally: Tally,
  now: Temporal.Instant,
): Promise<void> {
  const market = context.market;
  const waiting = await deps.unitOfWork.run(
    market,
    async () =>
      ok(await deps.payouts.listByState(market, ['awaiting-approval', 'approved'], BATCH_SIZE)),
    { readOnly: true },
  );
  if (!waiting.ok) return;
  for (const payout of waiting.value) {
    // An approved payout also passes the checks of the day it is instructed (design 4.6).
    const gate =
      payout.state === 'approved'
        ? await gateSeller(deps, context, payout.sellerId)
        : ({ kind: 'open' } as const);
    if (gate.kind === 'unavailable') {
      tally.skipped += 1;
      continue;
    }
    const outcome = await deps.unitOfWork.run<Payout, Stale>(market, async () => {
      const locked = await deps.cursors.lock(market, payout.sellerId);
      const current = await deps.payouts.findWithItems(market, payout.id);
      if (locked === null || current === null || current.payout.state !== payout.state) {
        return err({ code: 'stale' } as const);
      }
      const reason = await whyVoid(deps, market, current.payout, current.items, gate, now);
      const next =
        reason !== null
          ? moveTo(current.payout, 'voided', now, { outcomeCode: reason })
          : current.payout.state === 'approved'
            ? moveTo(current.payout, 'instructing', now, { instructingAt: now })
            : null;
      if (next === null) return ok(current.payout);
      if (!(await deps.payouts.change(market, current.payout, next))) {
        return err({ code: 'stale' } as const);
      }
      return ok(next);
    });
    if (!outcome.ok) continue;
    if (outcome.value.state === 'voided') tally.voided += 1;
    if (outcome.value.state === 'instructing') {
      await sendWithRecheck(deps, context, outcome.value, tally);
    }
    if (
      outcome.value.state === 'awaiting-approval' &&
      isLongWaiting(outcome.value, now) &&
      (await raiseApprovalAlert(deps, context, outcome.value))
    ) {
      tally.alerts += 1;
    }
  }
}

/**
 * Why a waiting payout must not go on, as the outcome code it is voided with, or null: a hold on
 * the seller or on one of its seller orders, a seller order worth less than when it was taken, or
 * (once approved, at the moment it would be instructed) a failed check.
 */
async function whyVoid(
  deps: PayoutDependencies,
  market: MarketContext,
  payout: Payout,
  items: readonly PayoutItem[],
  gate: GateAnswer,
  at: Temporal.Instant,
): Promise<string | null> {
  const holds = await deps.holds.listForSeller(market, payout.sellerId, {
    activeOnly: true,
    limit: HOLDS_READ_LIMIT,
  });
  const taken = new Set<string>(items.map((item) => item.sellerOrderId));
  if (holds.some((hold) => hold.sellerOrderId === null || taken.has(hold.sellerOrderId))) {
    return 'voided.hold';
  }
  const nets = new Map(
    (await deps.ledger.netBySellerOrder(market, payout.sellerId, payout.currency)).map((row) => [
      row.sellerOrderId,
      row.net,
    ]),
  );
  if (items.some((item) => (nets.get(item.sellerOrderId) ?? 0n) < item.amount)) {
    return 'voided.amount-changed';
  }
  if (payout.state === 'approved' && payout.approval !== null) {
    // The admin approved one amount. Plan it again: a receivable that grew (or shrank) since
    // changes what would be transferred, and then the approval no longer covers it.
    const fresh = await planSeller(
      deps,
      market,
      payout.sellerId,
      payout.currency,
      payout.minimum,
      at,
    );
    const netted = payout.gross < fresh.receivable ? payout.gross : fresh.receivable;
    if (payout.gross - netted !== payout.approval.approvedTransfer) return 'voided.amount-changed';
  }
  if (payout.state === 'approved' && gate.kind === 'blocked') {
    switch (gate.reason) {
      case 'account-not-ready':
        return 'voided.account-not-ready';
      case 'second-factor-required':
        return 'voided.second-factor';
      default:
        return 'voided.access';
    }
  }
  return null;
}

const isLongWaiting = (payout: Payout, now: Temporal.Instant): boolean => {
  const due = payout.stateChangedAt.add(APPROVAL_ALERT_AFTER);
  return (
    Temporal.Instant.compare(due, now) <= 0 &&
    Temporal.Instant.compare(due, now.subtract(RUN_INTERVAL)) > 0
  );
};

async function raiseApprovalAlert(
  deps: PayoutDependencies,
  context: CallContext,
  payout: Payout,
): Promise<boolean> {
  const done = await deps.unitOfWork.run<boolean, never>(context.market, async () => {
    await deps.securityEvents.record(
      context,
      PayoutAlert.event({ payload: { sellerId: payout.sellerId, reason: 'approval-waiting' } }),
    );
    return ok(true);
  });
  return done.ok;
}

// ---------------------------------------------------------------------------------------------
// Sending

const KEY_REUSED = 'idempotency.key-reused';

/**
 * Design 4.7 step 5: the seller is asked about again, after the unit that made the payout
 * INSTRUCTING has committed and right before the call. Anything but a clear yes (a seller
 * suspended meanwhile, an answer that is missing or odd, `unavailable`) fences the key at payments
 * and closes the payout as NOT_SENT `payout-unwound`; nothing was sent, so there is no quarantine.
 * When the fence cannot be confirmed the payout stays INSTRUCTING for the reconcile job.
 */
export async function sendWithRecheck(
  deps: PayoutDependencies,
  context: CallContext,
  payout: Payout,
  tally: Tally | null,
): Promise<'instructed' | 'not-sent' | 'unknown'> {
  const eligible = await deps.access.eligible(context, [payout.sellerId]);
  if (eligible !== 'unavailable' && eligible.size === 1 && eligible.get(payout.sellerId) === true) {
    return sendTransfer(deps, context, payout, tally);
  }
  const answer = await deps.payments.abandon(context, payout.id);
  if (answer === 'unavailable' || answer.kind === 'in-flight') {
    if (tally !== null) tally.pendingAnswer += 1;
    return 'unknown';
  }
  const market = context.market;
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<'instructed' | 'not-sent', Stale>(market, async () => {
    const locked = await deps.cursors.lock(market, payout.sellerId);
    const current = await deps.payouts.find(market, payout.id);
    if (locked === null || current === null || current.state !== 'instructing') {
      return err({ code: 'stale' } as const);
    }
    const next =
      answer.kind === 'already-sent'
        ? moveTo(current, 'instructed', now, { transferExecutionId: answer.transferExecutionId })
        : moveTo(current, 'not-sent', now, { outcomeCode: 'payout-unwound' });
    if (!(await deps.payouts.change(market, current, next))) return err({ code: 'stale' } as const);
    return ok(next.state === 'instructed' ? ('instructed' as const) : ('not-sent' as const));
  });
  if (!done.ok) return 'unknown';
  if (tally !== null) {
    if (done.value === 'instructed') tally.instructed += 1;
    else tally.notSent += 1;
  }
  return done.value;
}

/**
 * Calls payments for a payout that is INSTRUCTING, after the unit that made it so has committed.
 * Accepted: INSTRUCTED with payments' transfer id. Refused: NOT_SENT with the code as given (the
 * seller sees the reason when it is one they can act on). Unknown (unavailable): nothing changes;
 * payments never re-sends, and the reconcile job asks by key and fences after the timeout.
 */
export async function sendTransfer(
  deps: PayoutDependencies,
  context: CallContext,
  payout: Payout,
  tally: Tally | null,
): Promise<'instructed' | 'not-sent' | 'unknown'> {
  const answer = await deps.payments.instruct(context, {
    instructionKey: payout.id,
    sellerId: payout.sellerId,
    amountMinor: payout.transfer,
    currency: payout.currency,
    reference: payout.id,
  });
  if (answer === 'unavailable') {
    if (tally !== null) tally.pendingAnswer += 1;
    return 'unknown';
  }
  const market = context.market;
  if (answer.kind === 'refused' && answer.code === KEY_REUSED) {
    // payments holds another record under this key, so a transfer may exist: not a definite
    // refusal. The payout stays INSTRUCTING for the reconcile job to settle, and a person looks.
    await deps.unitOfWork.run<true, never>(market, async () => {
      await deps.securityEvents.record(
        context,
        PayoutAlert.event({ payload: { sellerId: payout.sellerId, reason: 'transfer-refused' } }),
      );
      return ok(true as const);
    });
    if (tally !== null) tally.pendingAnswer += 1;
    return 'unknown';
  }
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run<'instructed' | 'not-sent', Stale>(market, async () => {
    const locked = await deps.cursors.lock(market, payout.sellerId);
    const current = await deps.payouts.find(market, payout.id);
    if (locked === null || current === null || current.state !== 'instructing') {
      return err({ code: 'stale' } as const);
    }
    if (answer.kind === 'accepted') {
      const next = moveTo(current, 'instructed', now, {
        transferExecutionId: answer.transferExecutionId,
      });
      if (!(await deps.payouts.change(market, current, next)))
        return err({ code: 'stale' } as const);
      return ok('instructed' as const);
    }
    const next = moveTo(current, 'not-sent', now, { outcomeCode: answer.code.toLowerCase() });
    if (!(await deps.payouts.change(market, current, next))) return err({ code: 'stale' } as const);
    // The seller is told why, when the refusal is something they can act on; anything else reads
    // as a pause and goes to the operators.
    const reason = blockReasonOfRefusal(answer.code);
    await deps.cursors.save(
      market,
      payout.sellerId,
      {
        lastSlotAt: locked.lastSlotAt,
        nextSlotAt: locked.nextSlotAt,
        zone: locked.zone,
        blockReason: reason,
        evaluatedAt: now,
      },
      now,
    );
    if (reason === 'payouts-paused') {
      await deps.securityEvents.record(
        context,
        PayoutAlert.event({ payload: { sellerId: payout.sellerId, reason: 'transfer-refused' } }),
      );
    }
    return ok('not-sent' as const);
  });
  if (!done.ok) return 'unknown';
  if (tally !== null) {
    if (done.value === 'instructed') tally.instructed += 1;
    else tally.notSent += 1;
  }
  return done.value;
}
