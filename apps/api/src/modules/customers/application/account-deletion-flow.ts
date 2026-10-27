import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../platform/unit-of-work/errors';
import {
  CLAIM_STALE_AFTER_MINUTES,
  scheduledForRequest,
  type AccountDeletionBlocker,
  type AccountDeletionRequest,
} from '../domain/account-deletion-request';
import {
  AccountDeletionCancelled,
  AccountDeletionCompleted,
  AccountDeletionRequested,
} from '../domain/audit';
import {
  AccountDeletionCancelledEvent,
  AccountDeletionCompletedEvent,
  AccountDeletionRequestedEvent,
  type AccountDeletionCancelReason,
} from '../domain/events';
import type { AccountDeletionDependencies } from './account-deletion-dependencies';
import {
  assertAccountDeletionAllowed,
  isActingAs,
  type AccountDeletionDisabled,
} from './account-deletion-settings-flow';

const logger = new Logger('AccountDeletion');

/**
 * What the buyer's screen reads about an open request: `pending` (can be cancelled) or `executing`
 * (the job has taken it; no longer cancellable).
 */
export interface AccountDeletionRequestView {
  readonly status: 'pending' | 'executing';
  readonly requestedAt: AccountDeletionRequest['requestedAt'];
  readonly scheduledFor: AccountDeletionRequest['scheduledFor'];
  readonly waitingPeriodDays: number;
}

const viewOf = (request: AccountDeletionRequest): AccountDeletionRequestView => ({
  status: request.status === 'executing' ? 'executing' : 'pending',
  requestedAt: request.requestedAt,
  scheduledFor: request.scheduledFor,
  waitingPeriodDays: request.waitingPeriodDays,
});

export type RequestAccountDeletionFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | AccountDeletionDisabled
  /** The typed list of what stands in the way; the buyer settles each, then asks again. */
  | {
      readonly code: 'customers.account-deletion-blocked';
      readonly blockers: readonly AccountDeletionBlocker[];
    }
  | { readonly code: 'customers.account-deletion-already-requested' }
  /** Another request of the account won the race: ask again. */
  | { readonly code: 'customers.conflict' }
  /** A blocker could not be read: the request fails closed. */
  | { readonly code: 'customers.unavailable' };

export type ViewAccountDeletionRequestFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'customers.account-deletion-request-not-found' };

export type CancelAccountDeletionFailure =
  | ViewAccountDeletionRequestFailure
  /** The job has claimed the request: it can no longer be cancelled. */
  | { readonly code: 'customers.account-deletion-in-progress' }
  /** A claim or another cancel won the race: ask again (the answer is then definite). */
  | { readonly code: 'customers.conflict' };

type BlockerReading = Result<readonly AccountDeletionBlocker[], { readonly code: 'unavailable' }>;

/**
 * What stands in the way of erasing an account, asked of each owning module through its facade.
 * `own` is the buyer's own request (their session's context); `account` the job's re-check under
 * the system actor. A module that cannot answer is a refusal (fail closed), never "nothing open".
 * Returns, disputes and chargebacks have no module yet, so they are not asked (notes.md).
 */
async function readBlockers(
  deps: AccountDeletionDependencies,
  context: CallContext,
  account: Id<'Account'> | null,
): Promise<BlockerReading> {
  const [obligations, balance] = await Promise.all([
    account === null
      ? deps.ordering.ownOpenObligations(context)
      : deps.ordering.openObligationsOf(context, account),
    account === null ? deps.wallet.ownBalanceOf(context) : deps.wallet.balanceOf(context, account),
  ]);
  if (!obligations.ok || !balance.ok) return err({ code: 'unavailable' });
  const blockers: AccountDeletionBlocker[] = [];
  if (obligations.value.openOrders > 0) {
    blockers.push({ code: 'open-orders', count: obligations.value.openOrders });
  }
  if (obligations.value.pendingRefunds > 0) {
    blockers.push({ code: 'pending-refunds', count: obligations.value.pendingRefunds });
  }
  if (balance.value.available.amount > 0n || balance.value.held.amount > 0n) {
    blockers.push({ code: 'wallet-balance' });
  }
  return ok(blockers);
}

const isCustomerSession = (context: CallContext) =>
  context.actor.kind === 'authenticated' &&
  context.actor.population === 'customer' &&
  !isActingAs(context);

/**
 * `POST customers/me/deletion-requests`: the buyer asks to delete their account. In order: the
 * Market's setting (`assertAccountDeletionAllowed`, refusing `customers.account-deletion-disabled`
 * before anything else is asked), the blockers (open orders, pending refunds, a wallet balance;
 * each module through its facade), then one serializable unit that asks the setting again, refuses
 * a second pending request, inserts the request at `now + waitingPeriodDays` and writes the audit
 * row and the outbox event. Afterwards identity ends the buyer's other sessions. There is no
 * customer step-up or OTP in the platform, so none is asked (notes.md).
 */
export async function requestAccountDeletion(
  deps: AccountDeletionDependencies,
  context: CallContext,
  input: { readonly confirm: unknown },
): Promise<Result<AccountDeletionRequestView, RequestAccountDeletionFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || !isCustomerSession(context)) {
    return err({ code: 'access.denied' });
  }
  if (input?.confirm !== true) {
    return err({ code: 'validation.failed', fields: [{ path: 'confirm', code: 'required' }] });
  }
  const { market } = context;

  const allowed = await deps.unitOfWork.run<number, AccountDeletionDisabled>(
    market,
    async () => {
      const guard = await assertAccountDeletionAllowed(deps.accountDeletionSettings, market);
      return guard.ok ? ok(guard.value.waitingPeriodDays) : err(guard.error);
    },
    { readOnly: true },
  );
  if (!allowed.ok) return err(allowed.error);

  const blockers = await readBlockers(deps, context, null);
  if (!blockers.ok) return err({ code: 'customers.unavailable' });
  if (blockers.value.length > 0) {
    return err({ code: 'customers.account-deletion-blocked', blockers: blockers.value });
  }

  let created: Result<AccountDeletionRequest, RequestAccountDeletionFailure>;
  try {
    created = await deps.unitOfWork.run<AccountDeletionRequest, RequestAccountDeletionFailure>(
      market,
      async () => {
        // The setting again, in this unit: it may have been switched off since the first read.
        const guard = await assertAccountDeletionAllowed(deps.accountDeletionSettings, market);
        if (!guard.ok) return err(guard.error);
        if ((await deps.requests.findActiveOf(market, actor.accountId)) !== null) {
          return err({ code: 'customers.account-deletion-already-requested' } as const);
        }
        const now = deps.clock.now();
        const waitingPeriodDays = guard.value.waitingPeriodDays;
        const request: AccountDeletionRequest = {
          id: deps.ids.next<'AccountDeletionRequest'>(),
          accountId: actor.accountId,
          status: 'pending',
          waitingPeriodDays,
          requestedAt: now,
          scheduledFor: scheduledForRequest(now, waitingPeriodDays),
          claimedAt: null,
        };
        if (!(await deps.requests.insertPending(market, request))) {
          return err({ code: 'customers.account-deletion-already-requested' } as const);
        }
        await deps.audit.record(
          context,
          AccountDeletionRequested.entry(request.id, {
            after: { waitingPeriodDays, scheduledFor: request.scheduledFor },
          }),
        );
        await deps.outbox.append(context, [
          AccountDeletionRequestedEvent.record({
            aggregateId: request.id,
            aggregateVersion: 1,
            occurredAt: now,
            payload: { waitingPeriodDays, scheduledFor: request.scheduledFor },
          }),
        ]);
        return ok(request);
      },
      { isolation: 'serializable' },
    );
  } catch (error) {
    if (error instanceof TransactionConflictError || error instanceof StaleAggregateError) {
      return err({ code: 'customers.conflict' });
    }
    throw error;
  }
  if (!created.ok) return err(created.error);

  // The lock: only the session that asked stays. A refusal here does not undo the request (it is
  // committed and will run); the buyer can still end other sessions from the profile.
  const ended = await deps.identity.endOtherCustomerSessions(context);
  logger.log({
    msg: 'customers.request-account-deletion',
    outcome: 'requested',
    otherSessions: ended.ok ? 'ended' : ended.error.code,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return ok(viewOf(created.value));
}

/** `GET customers/me/deletion-requests/current`: the buyer's open request (pending or executing), if any. */
export async function viewCurrentAccountDeletionRequest(
  deps: AccountDeletionDependencies,
  context: CallContext,
): Promise<Result<AccountDeletionRequestView, ViewAccountDeletionRequestFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || !isCustomerSession(context)) {
    return err({ code: 'access.denied' });
  }
  return deps.unitOfWork.run<AccountDeletionRequestView, ViewAccountDeletionRequestFailure>(
    context.market,
    async () => {
      const open = await deps.requests.findActiveOf(context.market, actor.accountId);
      return open === null
        ? err({ code: 'customers.account-deletion-request-not-found' } as const)
        : ok(viewOf(open));
    },
    { readOnly: true },
  );
}

/**
 * `DELETE customers/me/deletion-requests/current`, and the call the sign-in flow makes through the
 * facade: cancels the buyer's pending request during the wait. One unit: the pending row closed
 * as `cancelled`, an audit row and an outbox event. Only a `pending` request can be cancelled: once
 * the job has claimed it (`executing`) the answer is `customers.account-deletion-in-progress`
 * (409), and an answer of 204 therefore always means the account will not be erased. A request
 * claimed while this unit ran makes the serializable unit conflict: `customers.conflict`, and the
 * buyer's next try gets the definite answer. Signing in does not call it yet: identity has no
 * post-sign-in hook (notes.md).
 */
export async function cancelAccountDeletion(
  deps: AccountDeletionDependencies,
  context: CallContext,
  reason: AccountDeletionCancelReason,
): Promise<Result<{ readonly code: 'cancelled' }, CancelAccountDeletionFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || !isCustomerSession(context)) {
    return err({ code: 'access.denied' });
  }
  try {
    return await deps.unitOfWork.run<{ readonly code: 'cancelled' }, CancelAccountDeletionFailure>(
      context.market,
      async () => {
        const open = await deps.requests.findActiveOf(context.market, actor.accountId);
        if (open === null) {
          return err({ code: 'customers.account-deletion-request-not-found' } as const);
        }
        if (open.status === 'executing') {
          return err({ code: 'customers.account-deletion-in-progress' } as const);
        }
        const now = deps.clock.now();
        if (!(await deps.requests.cancel(context.market, open.id, reason, now))) {
          // Not pending any more: claimed or closed since the read. Say which.
          const again = await deps.requests.findActiveOf(context.market, actor.accountId);
          return again?.status === 'executing'
            ? err({ code: 'customers.account-deletion-in-progress' } as const)
            : err({ code: 'customers.account-deletion-request-not-found' } as const);
        }
        await deps.audit.record(
          context,
          AccountDeletionCancelled.entry(open.id, { after: { reason } }),
        );
        await deps.outbox.append(context, [
          AccountDeletionCancelledEvent.record({
            aggregateId: open.id,
            aggregateVersion: 2,
            occurredAt: now,
            payload: { reason },
          }),
        ]);
        return ok({ code: 'cancelled' } as const);
      },
      { isolation: 'serializable' },
    );
  } catch (error) {
    if (error instanceof TransactionConflictError || error instanceof StaleAggregateError) {
      return err({ code: 'customers.conflict' });
    }
    throw error;
  }
}

/** Requests the job takes per run; the next run takes the rest. */
export const DELETION_BATCH_SIZE = 25;

export interface ExecuteAccountDeletionsOutput {
  readonly completed: number;
  /** Open order, pending refund or wallet balance appeared during the wait: left pending. */
  readonly blocked: number;
  /**
   * A step refused: the request stays `executing` and the next run repeats it once the claim is
   * stale. A request another run claimed first is not counted at all.
   */
  readonly failed: number;
}

/**
 * The executor (rule `system`, worker role). For each due request (a pending one whose date has
 * come, or an executing one whose claim is stale, i.e. a run that died), in this order and each
 * step safe to repeat: (1) the blockers under the system actor, since a buyer may have ordered
 * during the wait (a blocked request stays pending, no side effect); (2) the CLAIM, in its own
 * serializable unit and before any irreversible step: the row goes `pending` to `executing` with
 * `claimed_at` (or a stale claim is taken again) by one conditional update, and only the run whose
 * update matched goes on, so a cancel (which matches only `pending`) and a second run can never
 * overlap with the work; (3) identity ends every remaining session of the account, so nothing can
 * be ordered or credited from here on; (4) the blockers once more, now that nothing can change: a
 * blocker found here gives the claim back (`pending` again, cancellable) and the request waits;
 * (5) identity erases the account (its subject key destroyed, the row, credential, sessions and
 * links deleted; `already-erased` on a re-run), recording the request id in its audit row; (6)
 * engagement forgets the account and reviews detaches the author of the account's reviews and
 * ratings (they stay as "Former customer", owner decisions ح6 and ن11); (7) one unit deletes the
 * account's `customers.addresses` rows, closes the request `completed` (only from `executing`),
 * and writes the audit row and the outbox event. A failure in a step leaves the request
 * `executing`; the next run after the claim is stale repeats the steps. Orders, tax invoices and
 * payments stay (ids only). Logs ids and counts only.
 */
export async function executeAccountDeletions(
  deps: AccountDeletionDependencies,
  context: CallContext,
): Promise<ExecuteAccountDeletionsOutput> {
  const { market } = context;
  const startedAt = deps.clock.now();
  const staleBefore = startedAt.subtract({ minutes: CLAIM_STALE_AFTER_MINUTES });
  const due = await deps.unitOfWork.run<readonly AccountDeletionRequest[], never>(
    market,
    async () =>
      ok(await deps.requests.listDue(market, startedAt, staleBefore, DELETION_BATCH_SIZE)),
    { readOnly: true },
  );
  if (!due.ok) return { completed: 0, blocked: 0, failed: 0 };
  let completed = 0;
  let blocked = 0;
  let failed = 0;
  const logBlocked = (request: AccountDeletionRequest, found: readonly AccountDeletionBlocker[]) =>
    logger.warn({
      msg: 'customers.account-deletion.blocked',
      requestId: request.id,
      blockers: found.map((b) => b.code),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
  for (const request of due.value) {
    try {
      const first = await readBlockers(deps, context, request.accountId);
      if (!first.ok) {
        failed += 1;
        continue;
      }
      if (first.value.length > 0) {
        // A stale claim with a blocker is given back too, so the buyer can cancel again.
        if (request.status === 'executing') {
          await releaseClaim(deps, market, request, request.claimedAt);
        }
        blocked += 1;
        logBlocked(request, first.value);
        continue;
      }

      const claimedAt = await claim(deps, market, request, startedAt, staleBefore);
      if (claimedAt === null) continue; // another run has it, or the buyer cancelled first

      const lockedOut = await deps.identity.endAllCustomerSessions(context, request.accountId);
      if (!lockedOut.ok) {
        failed += 1;
        continue;
      }
      const last = await readBlockers(deps, context, request.accountId);
      if (!last.ok) {
        failed += 1;
        continue;
      }
      if (last.value.length > 0) {
        await releaseClaim(deps, market, request, claimedAt);
        blocked += 1;
        logBlocked(request, last.value);
        continue;
      }

      const erased = await deps.identity.eraseCustomerAccount(
        context,
        request.accountId,
        request.id,
      );
      if (!erased.ok) {
        failed += 1;
        continue;
      }
      const forgotten = await deps.engagement.forgetAccount(context, request.accountId);
      if (!forgotten.ok) {
        failed += 1;
        continue;
      }
      const detached = await deps.reviews.detachAuthor(context, request.accountId);
      if (!detached.ok) {
        failed += 1;
        continue;
      }
      const closed = await deps.unitOfWork.run<boolean, never>(
        market,
        async () => {
          const now = deps.clock.now();
          await deps.addresses.removeAllOf(market, request.accountId);
          if (!(await deps.requests.complete(market, request.id, now))) return ok(false);
          await deps.audit.record(
            context,
            AccountDeletionCompleted.entry(request.id, {
              after: { waitingPeriodDays: request.waitingPeriodDays },
            }),
          );
          await deps.outbox.append(context, [
            AccountDeletionCompletedEvent.record({
              aggregateId: request.id,
              aggregateVersion: 2,
              occurredAt: now,
              payload: { waitingPeriodDays: request.waitingPeriodDays },
            }),
          ]);
          return ok(true);
        },
        { isolation: 'serializable' },
      );
      if (closed.ok && closed.value) completed += 1;
      else failed += 1;
    } catch (error) {
      // One request that fails must not stop the others; it stays as it is (executing once
      // claimed) and a later run repeats its steps. Only the error's class name is logged: a
      // message could carry data.
      failed += 1;
      logger.warn({
        msg: 'customers.account-deletion.failed',
        requestId: request.id,
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  return { completed, blocked, failed };
}

/**
 * The claim, in its own serializable unit. Returns the claim's instant, or null when it was not
 * won: the row no longer matched (cancelled, claimed by another run) or the unit conflicted with
 * the cancel or the other run, which is the same answer.
 */
async function claim(
  deps: AccountDeletionDependencies,
  market: MarketContext,
  request: AccountDeletionRequest,
  at: Temporal.Instant,
  staleBefore: Temporal.Instant,
): Promise<Temporal.Instant | null> {
  try {
    const won = await deps.unitOfWork.run<boolean, never>(
      market,
      async () => ok(await deps.requests.claim(market, request.id, at, staleBefore)),
      { isolation: 'serializable' },
    );
    return won.ok && won.value ? at : null;
  } catch (error) {
    if (error instanceof TransactionConflictError || error instanceof StaleAggregateError) {
      return null;
    }
    throw error;
  }
}

/** Gives a claim back after a blocker; a refusal is harmless (the stale-claim rule picks it up). */
async function releaseClaim(
  deps: AccountDeletionDependencies,
  market: MarketContext,
  request: AccountDeletionRequest,
  claimedAt: Temporal.Instant | null,
): Promise<void> {
  if (claimedAt === null) return;
  try {
    await deps.unitOfWork.run<boolean, never>(
      market,
      async () => ok(await deps.requests.release(market, request.id, claimedAt)),
      { isolation: 'serializable' },
    );
  } catch (error) {
    if (!(error instanceof TransactionConflictError || error instanceof StaleAggregateError)) {
      throw error;
    }
  }
}
