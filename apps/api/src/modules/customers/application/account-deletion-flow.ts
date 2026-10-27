import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../platform/unit-of-work/errors';
import {
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

/** What the buyer's screen reads about a pending request. */
export interface AccountDeletionRequestView {
  readonly status: 'pending';
  readonly requestedAt: AccountDeletionRequest['requestedAt'];
  readonly scheduledFor: AccountDeletionRequest['scheduledFor'];
  readonly waitingPeriodDays: number;
}

const viewOf = (request: AccountDeletionRequest): AccountDeletionRequestView => ({
  status: 'pending',
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

export type CancelAccountDeletionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'customers.account-deletion-request-not-found' };

export type ViewAccountDeletionRequestFailure = CancelAccountDeletionFailure;

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
        if ((await deps.requests.findPendingOf(market, actor.accountId)) !== null) {
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

/** `GET customers/me/deletion-requests/current`: the buyer's pending request, if any. */
export async function viewCurrentAccountDeletionRequest(
  deps: AccountDeletionDependencies,
  context: CallContext,
): Promise<Result<AccountDeletionRequestView, ViewAccountDeletionRequestFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
    return err({ code: 'access.denied' });
  }
  return deps.unitOfWork.run<AccountDeletionRequestView, ViewAccountDeletionRequestFailure>(
    context.market,
    async () => {
      const pending = await deps.requests.findPendingOf(context.market, actor.accountId);
      return pending === null
        ? err({ code: 'customers.account-deletion-request-not-found' } as const)
        : ok(viewOf(pending));
    },
    { readOnly: true },
  );
}

/**
 * `DELETE customers/me/deletion-requests/current`, and the call the sign-in flow makes through the
 * facade: cancels the buyer's pending request during the wait. One unit: the pending row closed
 * as `cancelled` (a request that was no longer pending is "not found"), an audit row and an
 * outbox event. Signing in does not call it yet: identity has no post-sign-in hook (notes.md).
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
        const pending = await deps.requests.findPendingOf(context.market, actor.accountId);
        const now = deps.clock.now();
        if (
          pending === null ||
          !(await deps.requests.cancel(context.market, pending.id, reason, now))
        ) {
          return err({ code: 'customers.account-deletion-request-not-found' } as const);
        }
        await deps.audit.record(
          context,
          AccountDeletionCancelled.entry(pending.id, { after: { reason } }),
        );
        await deps.outbox.append(context, [
          AccountDeletionCancelledEvent.record({
            aggregateId: pending.id,
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
      return err({ code: 'customers.account-deletion-request-not-found' });
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
  /** A step refused or another worker closed it first: left for the next run. */
  readonly failed: number;
}

/**
 * The executor (rule `system`, worker role): for each due pending request, in this order and each
 * step safe to repeat: (1) the blockers again under the system actor, since a buyer may have
 * ordered during the wait (a blocked request stays pending and is asked again next run); (2)
 * identity erases the account (its subject key destroyed, the row, credential, sessions and links
 * deleted; `already-erased` on a re-run); (3) engagement forgets the account and reviews detaches
 * the author of the account's reviews and ratings (they stay as "Former customer", owner decisions
 * ح6 and ن11); (4) one unit deletes
 * the account's `customers.addresses` rows, closes the request `completed` (only if still
 * pending), and writes the audit row and the outbox event. A failure in a step leaves the request
 * pending, so the next run repeats the steps. Orders, tax invoices and payments stay (ids only).
 * Logs ids and counts only.
 */
export async function executeAccountDeletions(
  deps: AccountDeletionDependencies,
  context: CallContext,
): Promise<ExecuteAccountDeletionsOutput> {
  const { market } = context;
  const due = await deps.unitOfWork.run<readonly AccountDeletionRequest[], never>(
    market,
    async () => ok(await deps.requests.listDue(market, deps.clock.now(), DELETION_BATCH_SIZE)),
    { readOnly: true },
  );
  if (!due.ok) return { completed: 0, blocked: 0, failed: 0 };
  let completed = 0;
  let blocked = 0;
  let failed = 0;
  for (const request of due.value) {
    try {
      const blockers = await readBlockers(deps, context, request.accountId);
      if (!blockers.ok) {
        failed += 1;
        continue;
      }
      if (blockers.value.length > 0) {
        blocked += 1;
        logger.warn({
          msg: 'customers.account-deletion.blocked',
          requestId: request.id,
          blockers: blockers.value.map((b) => b.code),
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        continue;
      }
      const erased = await deps.identity.eraseCustomerAccount(context, request.accountId);
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
      // One request that fails must not stop the others; the next run repeats its steps. Only the
      // error's class name is logged: a message could carry data.
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
