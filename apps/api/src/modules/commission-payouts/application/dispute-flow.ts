import { Logger } from '@nestjs/common';
import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { AccessDeclaration } from '../../../platform/authz';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../contracts/permissions';
import { DisputeOrderMismatch } from '../../../platform/security-events/security-event-catalogue';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { DisputeDecided, PayoutHoldPlaced, PayoutHoldReleased } from '../domain/audit';
import {
  DECISION_BEARERS,
  DECISION_REASON_CODES,
  DISPUTE_BUCKETS,
  bucketOf,
  decisionRule,
  decisionsBySellerOrder,
  moneyStateOf,
  needsReview,
  recoverableCap,
  recoveredOf,
  releasable,
  sellerShareOf,
  type DecisionBearer,
  type DecisionReasonCode,
  type DisputeBucket,
  type DisputeCase,
  type DisputeDecision,
  type DisputeMoneyState,
  type SellerOrderDecision,
} from '../domain/dispute';
import { SellerOrderDisputed } from '../domain/events';
import type { LedgerEntry } from '../domain/ledger';
import type { DisputeDependencies } from './dispute-dependencies';
import type { ProviderDispute } from './ports/dispute-source';
import type { SellerOrderRef } from './ports/dispute.repository';

// Dispute effects (Phase 5 package 8b; docs/design/domain/commission-payouts.md 4.10).
//
// `syncDispute` runs on `payments.dispute-changed.v1`. The event is a trigger only: it reads the
// dispute through payments and acts on the state it returns, never on the event's version. An open
// case holds the money of the order's seller orders (D7); a closed one releases the holds when it
// was won, was an inquiry, or was lost and every seller order has a decision. The bank taking or
// returning money never writes the seller ledger: only an admin's decision does (D5, G2 4.10).

const logger = new Logger('CommissionPayoutsDisputes');

type Fields = readonly { path: string; code: string }[];

export type DisputeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: Fields }
  /** Unknown, or another Market's, dispute: byte-identical. */
  | { readonly code: 'commission-payouts.dispute-not-found' }
  /** The seller order is not one of the dispute's order (or has no ledger rows). */
  | { readonly code: 'commission-payouts.seller-order-not-found' }
  | { readonly code: 'commission-payouts.dispute.not-decidable' }
  | { readonly code: 'commission-payouts.dispute.already-decided' }
  | { readonly code: 'commission-payouts.dispute.amount-out-of-range' }
  | { readonly code: 'commission-payouts.unavailable' };

export type DisputeEventFailure =
  { readonly code: 'validation.failed' } | { readonly code: 'commission-payouts.try-again' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

const adminOf = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin'
    ? context.actor
    : null;

// ---------------------------------------------------------------------------------------------
// The consumer

export type SyncOutcome = 'synced' | 'stale' | 'parked' | 'unknown-dispute' | 'already-handled';

/**
 * `payments.dispute-changed.v1`: brings the case, the holds and the seller notices up to date with
 * the dispute payments now stores. Idempotent end to end: a replay or an out-of-order delivery
 * gives the same state (the case keeps the newest version read, a hold is keyed on the dispute and
 * the seller order, a notice is written only when the hold is first placed).
 */
export async function syncDispute(
  deps: DisputeDependencies,
  context: CallContext,
  input: { readonly delivery: EventDelivery; readonly disputeId: unknown },
): Promise<Result<SyncOutcome, DisputeEventFailure>> {
  const disputeId = idOf<'Dispute'>(input?.disputeId);
  if (disputeId === null) return err({ code: 'validation.failed' });

  // Reads before the unit (they call other modules): the dispute, then the order's own PaymentIntent.
  const read = await deps.source.read(context, disputeId);
  if (read === 'unavailable') return err({ code: 'commission-payouts.try-again' });
  if (read === null) {
    // payments does not know it (not possible for a published event): nothing to act on.
    logger.warn({
      msg: 'commission-payouts.dispute-unknown',
      disputeId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return markHandled(deps, context, input.delivery, 'unknown-dispute');
  }
  const orderId = idOf<'Order'>(read.orderId);
  if (idOf<'Dispute'>(read.disputeId) !== disputeId || orderId === null) {
    return err({ code: 'validation.failed' });
  }
  const own = await deps.orders.paymentIntentOf(context, orderId);
  if (own === 'unavailable') return err({ code: 'commission-payouts.try-again' });
  if (!own.known || own.paymentIntentId !== read.paymentIntentRef) {
    // An unknown order or another order's PaymentIntent: hold nothing, snapshot nothing, raise the
    // alert and finish (the delivery is handled, so it is not retried for ever).
    const reason = own.known ? ('payment-intent-mismatch' as const) : ('unknown-order' as const);
    const done = await deps.unitOfWork.runOnce<SyncOutcome, DisputeEventFailure>(
      context.market,
      input.delivery,
      async () => {
        await deps.securityEvents.record(
          context,
          DisputeOrderMismatch.event({ payload: { disputeId, reason } }),
        );
        return ok('parked' as const);
      },
    );
    if (!done.ok) return done;
    return ok(done.value.handled ? done.value.value : 'already-handled');
  }

  const now = deps.clock.now();
  const done = await deps.unitOfWork.runOnce<SyncOutcome, DisputeEventFailure>(
    context.market,
    input.delivery,
    async () => {
      const market = context.market;
      const stored = await deps.disputes.find(market, disputeId);
      // A read older than the stored one changes nothing (an out-of-order delivery).
      if (stored !== null && stored.lastSyncedVersion > read.version) return ok('stale' as const);
      // A stored case belongs to one order for good (the identity never changes): a read that
      // names another order is not applied, and the alert is raised.
      if (stored !== null && stored.orderId !== orderId) {
        await deps.securityEvents.record(
          context,
          DisputeOrderMismatch.event({ payload: { disputeId, reason: 'order-changed' } }),
        );
        return ok('parked' as const);
      }

      const sellerOrders = await deps.disputes.sellerOrdersOfOrder(market, orderId);
      const sellerOrderIds = sellerOrders.map((s) => s.sellerOrderId);
      const decisions = decisionsBySellerOrder(await deps.disputes.decisionsOf(market, disputeId));
      const next = caseOf(read, disputeId, orderId, stored, now, sellerOrderIds, decisions);
      if (stored === null) {
        if (!(await deps.disputes.insert(market, next))) await deps.disputes.refresh(market, next);
      } else {
        await deps.disputes.refresh(market, next);
      }

      // Open, or lost with a seller order still undecided: the money stays held (also for a case
      // first seen already lost). Otherwise the holds go.
      if (releasable(next, sellerOrderIds, decisions)) {
        await releaseHolds(deps, context, disputeId, null, now);
      } else {
        for (const sellerOrder of sellerOrders) {
          await holdSellerOrder(deps, context, sellerOrder, disputeId, now);
        }
      }
      return ok('synced' as const);
    },
  );
  if (!done.ok) return done;
  const outcome: SyncOutcome = done.value.handled ? done.value.value : 'already-handled';
  logger.log({
    msg: `commission-payouts.dispute-${outcome}`,
    disputeId,
    eventId: input.delivery.eventId,
    attempt: input.delivery.attempt,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return ok(outcome);
}

async function markHandled(
  deps: DisputeDependencies,
  context: CallContext,
  delivery: EventDelivery,
  outcome: SyncOutcome,
): Promise<Result<SyncOutcome, DisputeEventFailure>> {
  const done = await deps.unitOfWork.runOnce<SyncOutcome, DisputeEventFailure>(
    context.market,
    delivery,
    () => Promise.resolve(ok(outcome)),
  );
  if (!done.ok) return done;
  return ok(done.value.handled ? outcome : 'already-handled');
}

function caseOf(
  read: ProviderDispute,
  disputeId: Id<'Dispute'>,
  orderId: Id<'Order'>,
  stored: DisputeCase | null,
  now: Temporal.Instant,
  sellerOrderIds: readonly Id<'SellerOrder'>[],
  decisions: ReadonlyMap<Id<'SellerOrder'>, SellerOrderDecision>,
): DisputeCase {
  const state = {
    status: read.status,
    closed: read.closed,
    outcome: read.outcome,
    fundsReinstated: read.fundsReinstated,
  };
  return {
    disputeId,
    orderId,
    providerDisputeId: read.providerDisputeId,
    amount: read.amount,
    status: read.status,
    inquiry: read.inquiry,
    closed: read.closed,
    outcome: read.outcome,
    reason: read.reason,
    evidenceDueBy: read.evidenceDueBy,
    fundsWithdrawn: read.fundsWithdrawn,
    fundsWithdrawnAt: read.fundsWithdrawnAt,
    fundsReinstated: read.fundsReinstated,
    fundsReinstatedAt: read.fundsReinstatedAt,
    openedAt: read.openedAt,
    closedAt: stored?.closedAt ?? (read.closed ? now : null),
    bucket: bucketOf(state, sellerOrderIds, decisions),
    lastSyncedVersion: read.version,
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
  };
}

/** The dispute hold on one seller order, with its audit row and the seller notice event. */
async function holdSellerOrder(
  deps: DisputeDependencies,
  context: CallContext,
  sellerOrder: SellerOrderRef,
  disputeId: Id<'Dispute'>,
  now: Temporal.Instant,
): Promise<void> {
  const market = context.market;
  const holdId = deps.ids.next<'PayoutHold'>();
  const placed = await deps.holds.insertIfAbsent(market, {
    id: holdId,
    sellerId: sellerOrder.sellerId,
    sellerOrderId: sellerOrder.sellerOrderId,
    reason: 'dispute',
    origin: 'system',
    sourceRef: disputeId,
    placedBy: null,
    placedAt: now,
    releasedAt: null,
    releasedBy: null,
    releaseReason: null,
  });
  if (!placed) return;
  await deps.audit.record(
    context,
    PayoutHoldPlaced.entry(holdId, {
      after: {
        sellerId: sellerOrder.sellerId,
        sellerOrderId: sellerOrder.sellerOrderId,
        reason: 'dispute',
        sourceRef: disputeId,
      },
    }),
  );
  // The seller is told once per (dispute, seller order): the hold's first placement. The version
  // counts the dispute holds the seller order has had.
  const version = await deps.holds.countForSellerOrder(
    market,
    sellerOrder.sellerOrderId,
    'dispute',
  );
  await deps.outbox.append(context, [
    SellerOrderDisputed.record({
      aggregateId: sellerOrder.sellerOrderId,
      aggregateVersion: version,
      occurredAt: now,
      payload: {
        sellerOrderId: sellerOrder.sellerOrderId,
        sellerId: sellerOrder.sellerId,
        orderId: sellerOrder.orderId,
        disputeId,
      },
    }),
  ]);
}

async function releaseHolds(
  deps: DisputeDependencies,
  context: CallContext,
  disputeId: Id<'Dispute'>,
  releasedBy: Id<'Account'> | null,
  now: Temporal.Instant,
): Promise<number> {
  const released = await deps.holds.releaseBySource(context.market, 'dispute', disputeId, {
    releasedAt: now,
    releasedBy,
    reason: 'resolved',
  });
  for (const hold of released) {
    await deps.audit.record(
      context,
      PayoutHoldReleased.entry(hold.id, {
        before: { sellerId: hold.sellerId, sellerOrderId: hold.sellerOrderId, reason: 'dispute' },
        after: { releaseReason: 'resolved' },
      }),
    );
  }
  return released.length;
}

// ---------------------------------------------------------------------------------------------
// Views

export interface MoneyView {
  readonly amountMinor: bigint;
  readonly currency: string;
}

const moneyView = (value: Money): MoneyView => ({
  amountMinor: value.amount,
  currency: value.currency,
});

export interface DisputeRowView {
  readonly disputeId: Id<'Dispute'>;
  readonly orderId: Id<'Order'>;
  readonly sellers: readonly {
    readonly sellerId: Id<'Seller'>;
    readonly storeName: string | null;
  }[];
  readonly reason: string;
  readonly moneyState: DisputeMoneyState;
  readonly status: DisputeCase['status'];
  readonly bucket: DisputeBucket;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly amount: MoneyView;
  readonly openedAt: Temporal.Instant;
}

export interface DisputeListView {
  readonly counts: Readonly<Record<DisputeBucket, number>>;
  readonly disputes: readonly DisputeRowView[];
  readonly nextCursor: string | null;
}

export const DISPUTE_PAGE_DEFAULT = 50;
export const DISPUTE_PAGE_MAX = 100;

const encodeCursor = (c: Pick<DisputeCase, 'openedAt' | 'disputeId'>) =>
  `${c.openedAt.epochMilliseconds}.${c.disputeId}`;

function decodeCursor(value: string) {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  if (match === null || !UUID.test(match[2]!)) return undefined;
  const disputeId = idOf<'Dispute'>(match[2]);
  if (disputeId === null) return undefined;
  return { openedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), disputeId };
}

/** An admin lists the cases of the Market, with the count of each bucket. */
export async function listDisputes(
  deps: DisputeDependencies,
  context: CallContext,
  input: { readonly filter?: unknown; readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<DisputeListView, DisputeFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  let bucket: DisputeBucket | null = null;
  if (input?.filter !== undefined) {
    if ((DISPUTE_BUCKETS as readonly unknown[]).includes(input.filter)) {
      bucket = input.filter as DisputeBucket;
    } else {
      fields.push({ path: 'filter', code: 'format' });
    }
  }
  let after: ReturnType<typeof decodeCursor> = undefined;
  if (input?.cursor !== undefined) {
    after = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined;
    if (after === undefined) fields.push({ path: 'cursor', code: 'format' });
  }
  let limit = DISPUTE_PAGE_DEFAULT;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit === 'number' &&
      Number.isInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= DISPUTE_PAGE_MAX
    ) {
      limit = input.limit;
    } else {
      fields.push({ path: 'limit', code: 'range' });
    }
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });

  const loaded = await deps.unitOfWork.run<
    {
      readonly rows: readonly DisputeCase[];
      readonly counts: ReadonlyMap<DisputeBucket, number>;
      readonly sellerOrders: readonly SellerOrderRef[];
    },
    DisputeFailure
  >(
    context.market,
    async () => {
      const rows = await deps.disputes.list(context.market, {
        bucket,
        limit: limit + 1,
        after: input?.cursor === undefined || after === undefined ? null : after,
      });
      const counts = await deps.disputes.counts(context.market);
      const sellerOrders = await deps.disputes.sellerOrdersOfOrders(
        context.market,
        rows.slice(0, limit).map((row) => row.orderId),
      );
      return ok({ rows, counts, sellerOrders });
    },
    { readOnly: true },
  );
  if (!loaded.ok) return loaded;
  const page = loaded.value.rows.slice(0, limit);
  const sellerIds = [...new Set(loaded.value.sellerOrders.map((s) => s.sellerId))];
  const names = await namesOf(deps, context, sellerIds);
  const sellersOf = (orderId: Id<'Order'>) => {
    const ids = [
      ...new Set(
        loaded.value.sellerOrders.filter((s) => s.orderId === orderId).map((s) => s.sellerId),
      ),
    ];
    return ids.map((sellerId) => ({ sellerId, storeName: names.get(sellerId) ?? null }));
  };
  const last = page[page.length - 1];
  return ok({
    counts: Object.fromEntries(
      DISPUTE_BUCKETS.map((b) => [b, loaded.value.counts.get(b) ?? 0]),
    ) as Record<DisputeBucket, number>,
    disputes: page.map((c) => ({
      disputeId: c.disputeId,
      orderId: c.orderId,
      sellers: sellersOf(c.orderId),
      reason: c.reason,
      moneyState: moneyStateOf(c),
      status: c.status,
      bucket: c.bucket,
      evidenceDueBy: c.evidenceDueBy,
      amount: moneyView(c.amount),
      openedAt: c.openedAt,
    })),
    nextCursor: loaded.value.rows.length > limit && last !== undefined ? encodeCursor(last) : null,
  });
}

async function namesOf(
  deps: DisputeDependencies,
  context: CallContext,
  sellerIds: readonly Id<'Seller'>[],
): Promise<ReadonlyMap<Id<'Seller'>, string | null>> {
  if (sellerIds.length === 0) return new Map();
  const names = await deps.sellerNames.storeNames(context, sellerIds);
  // A name is a nicety: a failed read degrades to the id, never to a refused page.
  return names === 'unavailable' ? new Map() : names;
}

export interface DecisionView {
  readonly bearer: DecisionBearer;
  readonly amount: MoneyView | null;
  readonly reasonCode: DecisionReasonCode;
  readonly decidedBy: Id<'Account'>;
  readonly decidedAt: Temporal.Instant;
  /** The reversal of a seller decision (needs-review only), or null. */
  readonly reversal: {
    readonly reasonCode: DecisionReasonCode;
    readonly decidedBy: Id<'Account'>;
    readonly decidedAt: Temporal.Instant;
  } | null;
}

export interface DisputeSellerOrderView {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly storeName: string | null;
  /** The seller's unreversed share of the seller order, before any dispute recovery. */
  readonly sellerShare: MoneyView;
  /** The most that may be recovered now (share less what disputes already took, never below 0). */
  readonly recoverableCap: MoneyView;
  readonly holdActive: boolean;
  /** Whether an admin may record a decision now: a first one, or the reversal in needs-review. */
  readonly decision: 'allowed' | 'reversal-allowed' | 'not-allowed';
  readonly decided: DecisionView | null;
}

export type TimelineKind =
  'opened' | 'funds-withdrawn' | 'funds-reinstated' | 'closed' | 'decided' | 'decision-reversed';

export interface TimelineView {
  readonly kind: TimelineKind;
  readonly at: Temporal.Instant;
  readonly sellerOrderId: Id<'SellerOrder'> | null;
}

export interface DisputeDetailView {
  readonly disputeId: Id<'Dispute'>;
  readonly orderId: Id<'Order'>;
  readonly providerDisputeId: string;
  readonly amount: MoneyView;
  readonly status: DisputeCase['status'];
  readonly inquiry: boolean;
  readonly closed: boolean;
  readonly outcome: 'won' | 'lost' | null;
  readonly reason: string;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly moneyState: DisputeMoneyState;
  readonly bucket: DisputeBucket;
  readonly needsReview: boolean;
  readonly openedAt: Temporal.Instant;
  readonly sellerOrders: readonly DisputeSellerOrderView[];
  readonly timeline: readonly TimelineView[];
}

const decisionView = (d: SellerOrderDecision): DecisionView => ({
  bearer: d.first.bearer,
  amount: d.first.amount === null ? null : moneyView(d.first.amount),
  reasonCode: d.first.reasonCode,
  decidedBy: d.first.decidedBy,
  decidedAt: d.first.decidedAt,
  reversal:
    d.reversal === null
      ? null
      : {
          reasonCode: d.reversal.reasonCode,
          decidedBy: d.reversal.decidedBy,
          decidedAt: d.reversal.decidedAt,
        },
});

/** An admin reads one case: its seller orders (cap, hold, decision) and its timeline. */
export async function viewDispute(
  deps: DisputeDependencies,
  context: CallContext,
  input: { readonly disputeId: unknown },
): Promise<Result<DisputeDetailView, DisputeFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const disputeId = idOf<'Dispute'>(input?.disputeId);
  if (disputeId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'disputeId', code: 'format' }] });
  }
  const loaded = await deps.unitOfWork.run<
    {
      readonly c: DisputeCase;
      readonly sellerOrders: readonly SellerOrderRef[];
      readonly entries: ReadonlyMap<Id<'SellerOrder'>, readonly LedgerEntry[]>;
      readonly decisions: readonly DisputeDecision[];
      readonly activeHolds: ReadonlySet<Id<'SellerOrder'>>;
    },
    DisputeFailure
  >(
    context.market,
    async () => {
      const c = await deps.disputes.find(context.market, disputeId);
      if (c === null) return err({ code: 'commission-payouts.dispute-not-found' } as const);
      const sellerOrders = await deps.disputes.sellerOrdersOfOrder(context.market, c.orderId);
      const entries = new Map<Id<'SellerOrder'>, readonly LedgerEntry[]>();
      for (const sellerOrder of sellerOrders) {
        entries.set(
          sellerOrder.sellerOrderId,
          await deps.ledger.listSellerOrder(context.market, sellerOrder.sellerOrderId),
        );
      }
      const decisions = await deps.disputes.decisionsOf(context.market, disputeId);
      const holds = await deps.holds.listBySource(context.market, 'dispute', disputeId);
      const activeHolds = new Set(
        holds
          .filter((h) => h.releasedAt === null && h.sellerOrderId !== null)
          .map((h) => h.sellerOrderId!),
      );
      return ok({ c, sellerOrders, entries, decisions, activeHolds });
    },
    { readOnly: true },
  );
  if (!loaded.ok) return loaded;
  const { c, sellerOrders, entries, decisions, activeHolds } = loaded.value;
  const names = await namesOf(deps, context, [...new Set(sellerOrders.map((s) => s.sellerId))]);
  const bySellerOrder = decisionsBySellerOrder(decisions);
  const currency = c.amount.currency;
  const sellerOrderViews: DisputeSellerOrderView[] = sellerOrders.map((sellerOrder) => {
    const rows = entries.get(sellerOrder.sellerOrderId) ?? [];
    const decided = bySellerOrder.get(sellerOrder.sellerOrderId);
    const rule = decisionRule(c, decided, 'platform');
    return {
      sellerOrderId: sellerOrder.sellerOrderId,
      sellerId: sellerOrder.sellerId,
      storeName: names.get(sellerOrder.sellerId) ?? null,
      sellerShare: { amountMinor: sellerShareOf(rows), currency },
      recoverableCap: { amountMinor: recoverableCap(rows), currency },
      holdActive: activeHolds.has(sellerOrder.sellerOrderId),
      decision: rule.ok
        ? rule.kind === 'reverse'
          ? 'reversal-allowed'
          : 'allowed'
        : 'not-allowed',
      decided: decided === undefined ? null : decisionView(decided),
    };
  });
  const timeline: TimelineView[] = [{ kind: 'opened', at: c.openedAt, sellerOrderId: null }];
  if (c.fundsWithdrawnAt !== null) {
    timeline.push({ kind: 'funds-withdrawn', at: c.fundsWithdrawnAt, sellerOrderId: null });
  }
  if (c.fundsReinstatedAt !== null) {
    timeline.push({ kind: 'funds-reinstated', at: c.fundsReinstatedAt, sellerOrderId: null });
  }
  if (c.closedAt !== null) timeline.push({ kind: 'closed', at: c.closedAt, sellerOrderId: null });
  for (const d of decisions) {
    timeline.push({
      kind: d.supersedes === null ? 'decided' : 'decision-reversed',
      at: d.decidedAt,
      sellerOrderId: d.sellerOrderId,
    });
  }
  timeline.sort((a, b) => Temporal.Instant.compare(a.at, b.at));
  return ok({
    disputeId: c.disputeId,
    orderId: c.orderId,
    providerDisputeId: c.providerDisputeId,
    amount: moneyView(c.amount),
    status: c.status,
    inquiry: c.inquiry,
    closed: c.closed,
    outcome: c.outcome,
    reason: c.reason,
    evidenceDueBy: c.evidenceDueBy,
    moneyState: moneyStateOf(c),
    bucket: c.bucket,
    needsReview: needsReview(c),
    openedAt: c.openedAt,
    sellerOrders: sellerOrderViews,
    timeline,
  });
}

// ---------------------------------------------------------------------------------------------
// The decision

export interface DisputeDecisionView {
  readonly disputeId: Id<'Dispute'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly bearer: DecisionBearer;
  readonly amount: MoneyView | null;
  readonly reasonCode: DecisionReasonCode;
  readonly reversal: boolean;
  readonly decidedBy: Id<'Account'>;
  readonly decidedAt: Temporal.Instant;
  /** Whether this decision completed the case and released its holds. */
  readonly holdsReleased: boolean;
  readonly bucket: DisputeBucket;
}

const AMOUNT = /^[1-9][0-9]{0,17}$/;

/**
 * An admin decides who bears a lost chargeback on one seller order (D5). The platform bears it: no
 * ledger row. The seller repays `amountMinor` (0 < amount <= its unreversed share, Q-O4): one
 * `dispute-debit` row. After a reinstatement (needs-review), a seller decision may be reversed to
 * the platform once: one `dispute-reinstate` row. The decision, its ledger row, the audit row and
 * the release of the holds (when every seller order is decided) are one unit.
 */
export async function decideDispute(
  deps: DisputeDependencies,
  context: CallContext,
  input: {
    readonly disputeId: unknown;
    readonly sellerOrderId: unknown;
    readonly bearer: unknown;
    readonly amountMinor?: unknown;
    readonly reasonCode: unknown;
  },
): Promise<Result<DisputeDecisionView, DisputeFailure>> {
  const actor = adminOf(context);
  if (actor === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  const disputeId = idOf<'Dispute'>(input?.disputeId);
  if (disputeId === null) fields.push({ path: 'disputeId', code: 'format' });
  const sellerOrderId = idOf<'SellerOrder'>(input?.sellerOrderId);
  if (sellerOrderId === null) fields.push({ path: 'sellerOrderId', code: 'format' });
  const bearer = input?.bearer as DecisionBearer;
  if (!DECISION_BEARERS.includes(bearer)) fields.push({ path: 'bearer', code: 'format' });
  const reasonCode = input?.reasonCode as DecisionReasonCode;
  if (!DECISION_REASON_CODES.includes(reasonCode))
    fields.push({ path: 'reasonCode', code: 'format' });
  let requested: bigint | null = null;
  const given = input?.amountMinor;
  if (bearer === 'seller') {
    if (typeof given !== 'string' || !AMOUNT.test(given)) {
      fields.push({ path: 'amountMinor', code: 'format' });
    } else {
      requested = BigInt(given);
    }
  } else if (bearer === 'platform' && given !== undefined && given !== null) {
    fields.push({ path: 'amountMinor', code: 'not-allowed' });
  }
  if (disputeId === null || sellerOrderId === null || fields.length > 0) {
    return err({ code: 'validation.failed', fields });
  }

  const now = deps.clock.now();
  return deps.unitOfWork.run<DisputeDecisionView, DisputeFailure>(context.market, async () => {
    const market = context.market;
    // First, before any read the decision depends on: the case row, then the seller order. Decisions
    // of one dispute then run one after the other (the last one sees its siblings and releases the
    // holds), and so do decisions on one seller order, also of two disputes of one order (the cap).
    if (!(await deps.disputes.lockForDecision(market, disputeId, sellerOrderId))) {
      return err({ code: 'commission-payouts.dispute-not-found' } as const);
    }
    const c = await deps.disputes.find(market, disputeId);
    if (c === null) return err({ code: 'commission-payouts.dispute-not-found' } as const);
    const entries = await deps.ledger.listSellerOrder(market, sellerOrderId);
    const first = entries[0];
    if (first === undefined || first.orderId !== c.orderId) {
      return err({ code: 'commission-payouts.seller-order-not-found' } as const);
    }
    const sellerId = first.sellerId;
    const decisions = await deps.disputes.decisionsOf(market, disputeId);
    const bySellerOrder = decisionsBySellerOrder(decisions);
    const rule = decisionRule(c, bySellerOrder.get(sellerOrderId), bearer);
    if (!rule.ok) return err({ code: rule.code } as const);

    const cap = recoverableCap(entries);
    const currency = c.amount.currency;
    const existing = bySellerOrder.get(sellerOrderId);
    let amount: Money | null = null;
    if (rule.kind === 'reverse') {
      amount = existing?.first.amount ?? null;
    } else if (bearer === 'seller') {
      if (
        requested === null ||
        requested <= 0n ||
        requested > cap ||
        first.amount.currency !== currency
      ) {
        return err({ code: 'commission-payouts.dispute.amount-out-of-range' } as const);
      }
      amount = money(requested, currency);
    }

    const decision: DisputeDecision = {
      id: deps.ids.next<'DisputeDecision'>(),
      disputeId,
      sellerOrderId,
      sellerId,
      bearer: rule.kind === 'reverse' ? 'platform' : bearer,
      amount: rule.kind === 'reverse' ? null : amount,
      reasonCode,
      decidedBy: actor.accountId,
      decidedAt: now,
      supersedes: rule.kind === 'reverse' && existing !== undefined ? existing.first.id : null,
    };
    if (!(await deps.disputes.insertDecision(market, decision))) {
      // A concurrent decision got in first.
      return err({ code: 'commission-payouts.dispute.already-decided' } as const);
    }
    if (amount !== null) {
      await deps.ledger.append(market, [
        {
          id: deps.ids.next<'LedgerEntry'>(),
          sellerId,
          orderId: c.orderId,
          sellerOrderId,
          orderLineId: null,
          kind: rule.kind === 'reverse' ? 'dispute-reinstate' : 'dispute-debit',
          amount,
          rateBps: null,
          baseAmount: null,
          sourceId: disputeId,
          occurredAt: now,
          recordedAt: now,
        },
      ]);
    }
    await deps.audit.record(
      context,
      DisputeDecided.entry(decision.id, {
        before: {
          bearer: existing === undefined ? null : existing.first.bearer,
          // Absent when nothing is left to recover (a money field is never zero).
          capAmount: cap > 0n ? money(cap, currency) : null,
        },
        after: {
          disputeId,
          sellerOrderId,
          sellerId,
          bearer: decision.bearer,
          amount: decision.amount,
          reasonCode,
          reversal: rule.kind === 'reverse',
        },
      }),
    );

    const after = decisionsBySellerOrder([...decisions, decision]);
    const sellerOrderIds = (await deps.disputes.sellerOrdersOfOrder(market, c.orderId)).map(
      (s) => s.sellerOrderId,
    );
    const bucket = bucketOf(c, sellerOrderIds, after);
    if (bucket !== c.bucket) await deps.disputes.setBucket(market, disputeId, bucket, now);
    let holdsReleased = false;
    if (releasable(c, sellerOrderIds, after)) {
      holdsReleased = (await releaseHolds(deps, context, disputeId, actor.accountId, now)) > 0;
    }
    return ok({
      disputeId,
      sellerOrderId,
      sellerId,
      bearer: decision.bearer,
      amount: decision.amount === null ? null : moneyView(decision.amount),
      reasonCode,
      reversal: rule.kind === 'reverse',
      decidedBy: actor.accountId,
      decidedAt: now,
      holdsReleased,
      bucket,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The seller's read

export interface OwnDisputeView {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderId: Id<'Order'>;
  readonly since: Temporal.Instant;
  /** The dispute still holds this seller order's money. */
  readonly open: boolean;
  /**
   * What the seller repaid after a decision; null when none, when it was reversed, or when the
   * reader does not hold `commission-payouts.earnings.view`.
   */
  readonly recoveredAmount: MoneyView | null;
}

const OWN_HOLD_LIMIT = 100;

/** The second key of the seller's read: the repaid amount (asked of the AuthorisationCheck only). */
const OWN_AMOUNT_ACCESS: AccessDeclaration = {
  name: 'commission-payouts.list-own-disputes-amount',
  rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key] },
  whenSellerNotApproved: 'allow',
};

/**
 * The signed-in seller's seller orders that a dispute holds or held: no reason, no evidence date,
 * no provider id, no buyer or card data (D8). Only the seller's own holds and decisions are read.
 */
export async function listOwnDisputes(
  deps: DisputeDependencies,
  context: CallContext,
): Promise<Result<readonly OwnDisputeView[], DisputeFailure>> {
  const actor = context.actor;
  const sellerId =
    actor.kind === 'authenticated' && actor.population === 'seller'
      ? idOf<'Seller'>(actor.sellerId)
      : null;
  if (sellerId === null) return err({ code: 'access.denied' });
  // The amount a seller repaid is earnings data: shown only to a member who also holds
  // `commission-payouts.earnings.view`. The held banner needs no such key. Asked before the unit
  // (the check reads in a unit of its own); an error or a refusal is "no".
  const mayViewAmounts = await deps.authorisation
    .check(context, OWN_AMOUNT_ACCESS)
    .then((decision) => decision.allowed)
    .catch(() => false);
  return deps.unitOfWork.run<readonly OwnDisputeView[], DisputeFailure>(
    context.market,
    async () => {
      const holds = (
        await deps.holds.listForSeller(context.market, sellerId, {
          activeOnly: false,
          limit: OWN_HOLD_LIMIT,
        })
      ).filter((hold) => hold.reason === 'dispute' && hold.sellerOrderId !== null);
      const cases = await deps.disputes.findMany(
        context.market,
        holds.map((hold) => hold.sourceRef as Id<'Dispute'>),
      );
      const caseById = new Map(cases.map((c) => [c.disputeId as string, c]));
      const decisions = await deps.disputes.decisionsForSeller(context.market, sellerId);
      const views: OwnDisputeView[] = [];
      for (const hold of holds) {
        const c = caseById.get(hold.sourceRef);
        if (c === undefined || hold.sellerOrderId === null) continue;
        const decided = decisionsBySellerOrder(
          decisions.filter((d) => d.disputeId === c.disputeId),
        ).get(hold.sellerOrderId);
        const recovered = recoveredOf(decided);
        views.push({
          sellerOrderId: hold.sellerOrderId,
          orderId: c.orderId,
          since: hold.placedAt,
          open: hold.releasedAt === null,
          recoveredAmount: recovered === null || !mayViewAmounts ? null : moneyView(recovered),
        });
      }
      return ok(views);
    },
    { readOnly: true },
  );
}
