import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PaymentFailure } from '../../ordering';
import { statusOf } from '../domain/connected-account';
import type { PaymentsDependencies } from './payments-dependencies';
import type { EventOutcome, PendingEvent } from './ports/stripe-event-inbox';

/** Events applied per run; the next run takes the rest. */
export const APPLY_BATCH = 25;
/** After this many failed attempts an event is marked `failed` for an admin. */
export const MAX_ATTEMPTS = 12;
const FIRST_RETRY_SECONDS = 10;
const LAST_RETRY_SECONDS = 3600;

const CURRENCY = /^[a-z]{3}$/;

export interface ApplySummary {
  readonly applied: number;
  readonly retried: number;
  /** Events that ended `rejected` or `failed`: ids and outcomes only, for the log. */
  readonly problems: readonly { readonly eventId: string; readonly outcome: EventOutcome }[];
}

export type ApplyFailure = AccessDenied;

/** Seconds to wait after the n-th failed attempt: 10 s, doubling, at most an hour. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(LAST_RETRY_SECONDS, FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1));
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
  const read = await deps.connect.readAccount(event.objectId);
  if (!read.ok) return read.error.code === 'payment.provider-unavailable' ? 'retry' : 'rejected';
  const snapshot = read.value;
  const sellerId = snapshot.metadataSellerId;
  if (snapshot.id !== event.objectId || snapshot.metadataMarketId !== market.marketId) {
    return 'rejected';
  }
  if (sellerId === null) return 'rejected';
  const readAt = deps.clock.now();
  const stored = await deps.unitOfWork.run<boolean, never>(market, async () => {
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
    return ok(true);
  });
  if (!stored.ok) return 'failed';
  return stored.value ? 'account-updated' : 'rejected';
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
  if (event.type === 'account.updated' || event.type === 'capability.updated') {
    return applyAccountEvent(deps, context, event);
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

/**
 * `apply-stripe-events`: the stored events of this Market that are due, oldest first, one at a
 * time. Each ends with its outcome, or is tried again later with a growing delay; after
 * {@link MAX_ATTEMPTS} it is marked `failed`. Ordering's confirm and cancel are idempotent, so an
 * event applied twice (a late overlapping run) changes nothing the second time.
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
  const problems: { eventId: string; outcome: EventOutcome }[] = [];
  for (const event of due.value) {
    const result = await applyOne(deps, context, event);
    const attempts = event.attempts + 1;
    const outcome: Applied = result === 'retry' && attempts >= MAX_ATTEMPTS ? 'failed' : result;
    if (outcome === 'retry') {
      const next = deps.clock
        .now()
        .add(Temporal.Duration.from({ seconds: retryDelaySeconds(attempts) }));
      await deps.unitOfWork.run<true, never>(market, async () => {
        await deps.inbox.retryLater(market, event.eventId, attempts, next);
        return ok(true);
      });
      retried += 1;
      continue;
    }
    await deps.unitOfWork.run<boolean, never>(market, async () =>
      ok(await deps.inbox.finish(market, event.eventId, outcome, deps.clock.now())),
    );
    applied += 1;
    if (outcome === 'rejected' || outcome === 'failed') {
      problems.push({ eventId: event.eventId, outcome });
    }
  }
  return ok({ applied, retried, problems });
}
