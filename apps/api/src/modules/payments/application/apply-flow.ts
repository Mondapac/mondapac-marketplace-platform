import { Logger } from '@nestjs/common';
import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PaymentFailure } from '../../ordering';
import { PayoutChangeRecorded } from '../domain/audit';
import { statusOf } from '../domain/connected-account';
import {
  coolingOffAfter,
  isCoolingOff,
  isExternalAccountEvent,
  kindOf,
  type ChangeKind,
} from '../domain/payout-change';
import { decideHmac } from './external-account-check';
import { alertHmacKeyMissing } from './transfer-alerts';
import { isDisputeEventType } from '../domain/dispute';
import { isTransferEventType } from '../domain/transfer';
import { applyDisputeEvent } from './dispute-flow';
import { applyTransferEvent } from './transfer-events';
import type { PaymentsDependencies } from './payments-dependencies';
import {
  isAccountEventType,
  isCardPaymentEventType,
  type EventOutcome,
  type PendingEvent,
} from './ports/stripe-event-inbox';

/** Events applied per run; the next run takes the rest. */
export const APPLY_BATCH = 25;
/**
 * After this many started attempts an event is marked `failed` for an admin: at the end of the
 * last one when it did not succeed, or without applying it when a run finds it already taken this
 * many times (an event that kills the process on every attempt).
 */
export const MAX_ATTEMPTS = 12;
const FIRST_RETRY_SECONDS = 10;
const LAST_RETRY_SECONDS = 3600;
/**
 * The least wait before an event taken by a run is due again: the scheduler's job lock is held for
 * as long, so a run that overlaps a slow one does not apply the same event at the same time.
 */
export const MIN_RETRY_SECONDS = 60;
const JOB = 'payments.apply-stripe-events';

const logger = new Logger('ApplyStripeEvents');

const CURRENCY = /^[a-z]{3}$/;

export interface ApplySummary {
  readonly applied: number;
  readonly retried: number;
  /** Events whose applying (or whose outcome's write) threw; each is logged and tried again. */
  readonly threw: number;
  /** Events that ended `rejected` or `failed`: ids and outcomes only, for the log. */
  readonly problems: readonly { readonly eventId: string; readonly outcome: EventOutcome }[];
}

export type ApplyFailure = AccessDenied;

/** The back-off after the n-th attempt: 10 s, doubling, at most an hour. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(LAST_RETRY_SECONDS, FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/** When the n-th attempt, taken now, may be tried again: the back-off, never under a minute. */
function nextAttemptAfter(now: Temporal.Instant, attempts: number): Temporal.Instant {
  const seconds = Math.max(MIN_RETRY_SECONDS, retryDelaySeconds(attempts));
  return now.add(Temporal.Duration.from({ seconds }));
}

type Applied = EventOutcome | 'retry';

/** Maps ordering's answer: a temporary fault is a retry, any other refusal is final. */
function outcomeOf<T extends EventOutcome>(result: Result<T, PaymentFailure>): Applied {
  if (result.ok) return result.value;
  if (result.error.code === 'ordering.try-again') return 'retry';
  return result.error.code === 'access.denied' ? 'failed' : 'rejected';
}

/**
 * A connected-account event: the account is read again from Stripe and must carry this Market and
 * a seller that has this account stored (or, when the create call's answer was lost, a seller whose
 * row has no Stripe id yet, which then gets this one). Only what Stripe returns now is stored.
 */
async function applyAccountEvent(
  deps: PaymentsDependencies,
  context: CallContext,
  event: PendingEvent,
): Promise<Applied> {
  const market = context.market;
  const readAt = deps.clock.now();
  const read = await deps.connect.readAccount(event.objectId);
  if (!read.ok) return read.error.code === 'payment.provider-unavailable' ? 'retry' : 'rejected';
  const snapshot = read.value;
  const sellerId = snapshot.metadataSellerId;
  if (snapshot.id !== event.objectId || snapshot.metadataMarketId !== market.marketId) {
    return 'rejected';
  }
  if (sellerId === null) return 'rejected';
  const stored = await deps.unitOfWork.run<boolean, { readonly code: 'conflict' }>(
    market,
    async () => {
      let row = await deps.accounts.findByRef(market, snapshot.id);
      if (row === null) {
        const bySeller = await deps.accounts.find(market, sellerId);
        if (bySeller === null || bySeller.accountRef !== null) return ok(false);
        await deps.accounts.linkRef(market, sellerId, snapshot.id, readAt);
        row = await deps.accounts.findByRef(market, snapshot.id);
        if (row === null || row.sellerId !== sellerId) return ok(false);
      }
      if (row.sellerId !== sellerId) return ok(false);
      await deps.accounts.applyRead(
        market,
        sellerId,
        snapshot,
        statusOf(snapshot, row.status),
        readAt,
      );
      let pausedUntil = row.payoutsPausedUntil;
      // The default external account's keyed hash (package 6c): first stamped, re-stamped under a
      // newer key, or found different, which is a changed bank account whatever event brought it.
      const decision = decideHmac(
        deps.keyring,
        row.externalAccountHmac,
        snapshot.defaultExternalAccountId,
      );
      const nextHmac =
        decision.kind === 'stamp' || decision.kind === 'restamp' || decision.kind === 'changed'
          ? decision.next
          : undefined;
      if (decision.kind === 'key-missing' && row.externalAccountHmac !== null) {
        await alertHmacKeyMissing(deps, context, sellerId);
      }
      /** Records one change with its cooling-off and pause (and the new hash) in this unit. */
      const record = async (kind: ChangeKind): Promise<'recorded' | 'duplicate' | 'conflict'> => {
        const until = coolingOffAfter(
          kind,
          readAt,
          deps.policy.bankChangeCoolingOffHours(market),
          row.coolingOffUntil,
        );
        const changeId = deps.ids.next<'PayoutChange'>();
        const change = {
          id: changeId,
          kind,
          detectedAt: readAt,
          coolingOffUntil: kind === 'initial' ? null : until,
          sourceEventId: event.eventId,
          detectedBy: 'webhook' as const,
          ...(nextHmac === undefined ? {} : { externalAccountHmac: nextHmac }),
        };
        const recorded = await deps.accounts.recordChange(
          market,
          sellerId,
          change,
          row.lastChangeId,
          until,
          readAt,
        );
        if (recorded === 'recorded') {
          pausedUntil = until;
          await deps.audit.record(
            context,
            PayoutChangeRecorded.entry(sellerId as Id<'Seller'>, {
              after: { changeId, kind, coolingOffUntil: change.coolingOffUntil },
            }),
          );
        }
        return recorded;
      };
      let hmacWritten = false;
      if (isExternalAccountEvent(event.type)) {
        const kind = kindOf(event.type, {
          hasEarlierChange: row.lastChangeId !== null,
          neverEnabled:
            (row.status === 'not-started' || row.status === 'pending') && !row.payoutsEnabled,
          externalAccountCount: snapshot.externalAccountCount,
        });
        // A different account than the one on record is never the onboarding.
        const recorded = await record(
          decision.kind === 'changed' && kind === 'initial' ? 'updated' : kind,
        );
        // Another change got in first: nothing is kept, the event is read and applied again.
        if (recorded === 'conflict') return err({ code: 'conflict' });
        hmacWritten = recorded === 'recorded';
      }
      if (!hmacWritten && nextHmac !== undefined) {
        if (decision.kind === 'changed') {
          // A bank account that differs from the one on record, found by a read that no
          // external-account event reported: the same change, waiting period and pause.
          if ((await record('updated')) === 'conflict') return err({ code: 'conflict' });
        } else if (
          (await deps.accounts.stampExternalAccountHmac(
            market,
            sellerId,
            row.externalAccountHmac,
            nextHmac,
            readAt,
          )) !== 'stamped'
        ) {
          return err({ code: 'conflict' });
        }
      }
      // A pause that Stripe does not show (never applied, or the schedule was changed back) is
      // written again, whatever the applied state is.
      if (
        isCoolingOff(pausedUntil, readAt) &&
        snapshot.payoutScheduleInterval !== null &&
        snapshot.payoutScheduleInterval !== 'manual'
      ) {
        await deps.accounts.markRepause(market, sellerId, readAt);
      }
      return ok(true);
    },
  );
  if (!stored.ok) return 'retry';
  return stored.value ? 'account-updated' : 'rejected';
}

/**
 * A PaymentIntent event of a card payment made on the MondaPac page: the PaymentIntent is read
 * again from Stripe and must be a test-mode one of this Market, made by that flow, with an order
 * id; only what Stripe returns now is acted on, never the webhook payload. The order is confirmed
 * or cancelled by ordering exactly as for a Checkout session (no session id: the order must have
 * none).
 */
async function applyCardPaymentEvent(
  deps: PaymentsDependencies,
  context: CallContext,
  event: PendingEvent,
): Promise<Applied> {
  const read = await deps.reader.readPaymentIntent(event.objectId);
  if (!read.ok) return read.error.code === 'payment.provider-unavailable' ? 'retry' : 'rejected';
  const intent = read.value;
  const orderId = intent.metadataOrderId;
  if (
    intent.id !== event.objectId ||
    intent.livemode !== false ||
    intent.metadataPaymentFlow !== 'card-intent' ||
    intent.metadataMarketId !== context.market.marketId ||
    orderId === null
  ) {
    return 'rejected';
  }
  switch (event.type) {
    case 'payment_intent.amount_capturable_updated': {
      // Held: what can be captured. Already captured (a confirm that took the money and then
      // stopped, Hassan's finding): what was received, so ordering finds the same total and
      // finishes the confirmation instead of the order waiting with the money taken. Any other
      // state (cancelled since) is not a hold.
      const amount =
        intent.status === 'requires_capture'
          ? intent.amountCapturable
          : intent.status === 'succeeded'
            ? intent.amountReceived
            : null;
      if (amount === null) return 'ignored';
      if (!CURRENCY.test(intent.currency) || amount <= 0n) return 'rejected';
      return outcomeOf(
        await deps.ordering.confirmPayment(context, {
          orderId,
          paymentIntentId: intent.id,
          sessionId: null,
          amount: money(amount, intent.currency.toUpperCase()),
          // Read from Stripe now: ordering voids a hold that is not an accepted card.
          card: { methodType: intent.paymentMethodType ?? '', brand: intent.cardBrand },
        }),
      );
    }
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      // Only a PaymentIntent that really holds nothing: never one that holds or took the money.
      if (intent.status !== 'requires_payment_method' && intent.status !== 'canceled') {
        return 'ignored';
      }
      return outcomeOf(
        await deps.ordering.cancelPayment(context, { orderId, cause: 'payment-failed' }),
      );
    default:
      return 'ignored';
  }
}

/**
 * One stored event: the Checkout session is read again from Stripe and must be a test-mode
 * session of this Market whose order reference agrees in both places; only what Stripe returns
 * now is acted on, never the webhook payload.
 */
async function applyOne(
  deps: PaymentsDependencies,
  context: CallContext,
  event: PendingEvent,
): Promise<Applied> {
  if (isAccountEventType(event.type)) {
    return applyAccountEvent(deps, context, event);
  }
  if (isDisputeEventType(event.type)) {
    return applyDisputeEvent(deps, context, event);
  }
  if (isTransferEventType(event.type)) {
    return applyTransferEvent(deps, context, event);
  }
  if (isCardPaymentEventType(event.type)) {
    return applyCardPaymentEvent(deps, context, event);
  }
  const read = await deps.reader.readCheckoutSession(event.objectId);
  if (!read.ok) return read.error.code === 'payment.provider-unavailable' ? 'retry' : 'rejected';
  const session = read.value;
  const orderId = session.metadataOrderId;
  if (
    session.id !== event.objectId ||
    session.livemode !== false ||
    session.metadataMarketId !== context.market.marketId ||
    orderId === null ||
    session.clientReferenceId !== orderId
  ) {
    return 'rejected';
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const intent = session.paymentIntent;
      if (session.status !== 'complete' || intent === null) return 'rejected';
      // Held: what can be captured. Already captured (a confirm that stopped half-way): what was
      // received, so ordering finds the same total and finishes the confirmation.
      const amount =
        intent.status === 'requires_capture'
          ? intent.amountCapturable
          : intent.status === 'succeeded'
            ? intent.amountReceived
            : null;
      if (amount === null) return 'ignored';
      if (!CURRENCY.test(intent.currency) || amount <= 0n) return 'rejected';
      return outcomeOf(
        await deps.ordering.confirmPayment(context, {
          orderId,
          paymentIntentId: intent.id,
          sessionId: session.id,
          amount: money(amount, intent.currency.toUpperCase()),
        }),
      );
    }
    case 'checkout.session.expired':
      if (session.status !== 'expired') return 'rejected';
      return outcomeOf(await deps.ordering.cancelPayment(context, { orderId, cause: 'expired' }));
    case 'checkout.session.async_payment_failed': {
      // Only a session whose payment really failed: never one that holds or took the money.
      const intent = session.paymentIntent;
      const failed =
        intent === null ||
        intent.status === 'requires_payment_method' ||
        intent.status === 'canceled';
      if (session.status !== 'complete' || session.paymentStatus === 'paid' || !failed) {
        return 'rejected';
      }
      return outcomeOf(
        await deps.ordering.cancelPayment(context, { orderId, cause: 'payment-failed' }),
      );
    }
  }
}

/** The log line of an event whose applying, or whose outcome's write, threw. */
function logThrown(
  context: CallContext,
  event: PendingEvent,
  attempts: number,
  step: 'apply' | 'finish',
  error: unknown,
): void {
  // Ids and the error's name, code, SQLSTATE and frames only (the `err` serializer): never the
  // event's body, the error's message (a database error can quote column values) or order data.
  logger.error({
    msg: `${JOB}.threw`,
    step,
    eventId: event.eventId,
    type: event.type,
    attempts,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
    err: error,
  });
}

/**
 * `apply-stripe-events`: the stored events of this Market that are due, oldest first, one at a
 * time, each on its own so that one event can never hold up the others (FE-20261125 per-event
 * error isolation). An event is first taken (`claim`, in a unit of its own: one more attempt, and
 * the next attempt set), then applied; an error it throws is logged and counts as a retry, never
 * as `rejected` or `ignored`. So an event that throws, or kills the process, only moves itself
 * back in the queue, and after {@link MAX_ATTEMPTS} it is marked `failed` (also without applying
 * it, when a run finds it already taken that many times). Ordering's confirm and cancel are
 * idempotent, so an event applied twice changes nothing the second time. Only a `claim` that
 * throws (the database is unreachable) stops the run, after logging the problems found so far.
 */
export async function applyStripeEvents(
  deps: PaymentsDependencies,
  context: CallContext,
): Promise<Result<ApplySummary, ApplyFailure>> {
  const market = context.market;
  const due = await deps.unitOfWork.run<PendingEvent[], never>(
    market,
    async () => ok(await deps.inbox.due(market, deps.clock.now(), APPLY_BATCH)),
    { readOnly: true },
  );
  if (!due.ok) return due;
  let applied = 0;
  let retried = 0;
  let threw = 0;
  const problems: { eventId: string; outcome: EventOutcome }[] = [];
  /** Writes the outcome of the attempt this run holds; false when it was not written. */
  const finish = async (event: PendingEvent, outcome: EventOutcome, attempts: number) => {
    try {
      const done = await deps.unitOfWork.run<boolean, never>(market, async () =>
        ok(await deps.inbox.finish(market, event.eventId, outcome, deps.clock.now(), attempts)),
      );
      return done.ok && done.value;
    } catch (error) {
      // Tried again after its delay; ordering is idempotent, so the outcome stays the same.
      threw += 1;
      logThrown(context, event, attempts, 'finish', error);
      return false;
    }
  };
  for (const event of due.value) {
    if (event.attempts >= MAX_ATTEMPTS) {
      // Taken that many times and never finished: it stopped every attempt half-way.
      if (await finish(event, 'failed', event.attempts)) {
        applied += 1;
        problems.push({ eventId: event.eventId, outcome: 'failed' });
      }
      continue;
    }
    const attempts = event.attempts + 1;
    let claimed: boolean;
    try {
      const taken = await deps.unitOfWork.run<boolean, never>(market, async () =>
        ok(
          await deps.inbox.claim(
            market,
            event.eventId,
            event.attempts,
            nextAttemptAfter(deps.clock.now(), attempts),
          ),
        ),
      );
      claimed = taken.ok && taken.value;
    } catch (error) {
      // The database cannot be written: no event can be taken, so the run stops and the
      // scheduler logs it. What this run found already is logged first, so it is not lost.
      for (const problem of problems) {
        logger.error({
          msg: `${JOB}.${problem.outcome}`,
          marketId: market.marketId,
          correlationId: context.correlationId,
          ...problem,
        });
      }
      throw error;
    }
    // Another run took this attempt (or finished the event): it is theirs.
    if (!claimed) continue;
    let result: Applied;
    try {
      result = await applyOne(deps, context, event);
    } catch (error) {
      threw += 1;
      logThrown(context, event, attempts, 'apply', error);
      result = 'retry';
    }
    const outcome: Applied = result === 'retry' && attempts >= MAX_ATTEMPTS ? 'failed' : result;
    if (outcome === 'retry') {
      // Its next attempt was set when it was taken.
      retried += 1;
      continue;
    }
    if (!(await finish(event, outcome, attempts))) continue;
    applied += 1;
    if (outcome === 'rejected' || outcome === 'failed') {
      problems.push({ eventId: event.eventId, outcome });
    }
  }
  return ok({ applied, retried, threw, problems });
}
