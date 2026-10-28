import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../platform/unit-of-work/errors';
import { BUYER_ACCOUNT_DELETE_STEP_UP } from '../contracts/step-up';
import {
  parseAdminReason,
  parseTicketRef,
  scheduledForRequest,
  type AccountDeletionBlocker,
  type AccountDeletionRequest,
  type AccountDeletionRequester,
} from '../domain/account-deletion-request';
import type { FieldError } from '../domain/account-deletion-settings';
import { AccountDeletionCancelledByAdmin, AccountDeletionRequestedByAdmin } from '../domain/audit';
import {
  AccountDeletionCancelledByAdminEvent,
  AccountDeletionRequestedByAdminEvent,
} from '../domain/events';
import type { AccountDeletionDependencies } from './account-deletion-dependencies';
import { readBlockersAsAdmin } from './account-deletion-flow';
import {
  isActingAs,
  stepUpFailure,
  waitingPeriodInForce,
  type AccountDeletionSettingsFailure,
} from './account-deletion-settings-flow';
import type { PendingCursor } from './ports/account-deletion-request.repository';

const logger = new Logger('AdminAccountDeletion');

// An admin deletes a buyer's account for them (customers package 5c, API only). The request comes
// from the buyer through support, so the Market's self-service switch does not apply. Everything
// else is the buyer flow's: the same blockers, the same waiting period, one open request per
// account, the same executor. The admin's ticket reference and reason are free text: they are kept
// on the request row and never reach an event or an audit row.

type StepUpRefusal = Extract<
  AccountDeletionSettingsFailure,
  { code: 'second-factor.required' | 'second-factor.enrolment-required' | 'access.unavailable' }
>;

/** What the admin sees of the request they made. Ids and dates only. */
export interface AdminDeletionRequestMade {
  readonly requestId: Id<'AccountDeletionRequest'>;
  readonly status: 'pending';
  readonly requestedAt: Temporal.Instant;
  readonly scheduledFor: Temporal.Instant;
  readonly waitingPeriodDays: number;
}

export type AdminRequestDeletionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /** Unknown id, another population's, another Market's, or not an active customer: all alike. */
  | { readonly code: 'customers.buyer-account-not-found' }
  | {
      readonly code: 'customers.account-deletion-blocked';
      readonly blockers: readonly AccountDeletionBlocker[];
    }
  | { readonly code: 'customers.account-deletion-already-requested' }
  | { readonly code: 'customers.conflict' }
  | { readonly code: 'customers.unavailable' }
  | StepUpRefusal;

export type AdminCancelDeletionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  | { readonly code: 'customers.account-deletion-request-not-found' }
  | { readonly code: 'customers.account-deletion-in-progress' }
  | { readonly code: 'customers.conflict' }
  | StepUpRefusal;

export type AdminListDeletionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] };

/** One row of the pending list: no name, no email, no ticket text. */
export interface PendingDeletionRequestView {
  readonly requestId: Id<'AccountDeletionRequest'>;
  readonly accountId: Id<'Account'>;
  readonly requestedAt: Temporal.Instant;
  readonly scheduledFor: Temporal.Instant;
  readonly status: 'pending';
  readonly requestedBy: AccountDeletionRequester;
}

export interface PendingDeletionRequestPage {
  readonly entries: readonly PendingDeletionRequestView[];
  readonly nextCursor: string | null;
}

export const DELETION_LIST_DEFAULT_LIMIT = 20;
export const DELETION_LIST_MAX_LIMIT = 100;

/** A platform admin on a real admin session: not the system, a seller, a buyer or an acting-as session. */
function adminActor(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    return null;
  }
  return actor.accountId;
}

const isConflict = (error: unknown) =>
  error instanceof TransactionConflictError || error instanceof StaleAggregateError;

/**
 * `POST customers/admin/buyers/:accountId/deletion-requests`. In order: the admin and the body
 * (400 before anything is asked or spent); the buyer's account through identity (404 for anything
 * but an active customer account of the admin's Market); the blockers through each owning module
 * (409 with the typed list; a module that cannot answer fails closed, 503); then one serializable
 * unit: the waiting period in force, one open request per account (409), the admin's step-up proof
 * spent here and only here, the insert at `now + waitingPeriodDays`, the audit row and the outbox
 * event. Afterwards identity ends every session of the buyer (a failure is logged, the request
 * stays). The buyer is not asked: there is no buyer email facade to tell them (notes.md).
 */
export async function requestAccountDeletionForBuyer(
  deps: AccountDeletionDependencies,
  context: CallContext,
  input: {
    readonly accountId: unknown;
    readonly ticketRef: unknown;
    readonly reason: unknown;
    readonly confirm: unknown;
  },
): Promise<Result<AdminDeletionRequestMade, AdminRequestDeletionFailure>> {
  const adminId = adminActor(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const fields: FieldError[] = [];
  const ticketRef = parseTicketRef(input?.ticketRef);
  if (!ticketRef.ok) fields.push(ticketRef.error);
  const reason = parseAdminReason(input?.reason);
  if (!reason.ok) fields.push(reason.error);
  if (input?.confirm !== true) fields.push({ path: 'confirm', code: 'type' });
  if (fields.length > 0 || !ticketRef.ok || !reason.ok) {
    return err({ code: 'validation.failed', fields });
  }
  const parsedAccount =
    typeof input.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
  if (parsedAccount === null || !parsedAccount.ok) {
    return err({ code: 'customers.buyer-account-not-found' });
  }
  const accountId = parsedAccount.value;
  const { market } = context;

  const known = await deps.identity.customerAccountOf(context, accountId);
  if (!known.ok) {
    return err(
      known.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'customers.unavailable' },
    );
  }
  if (known.value === null) return err({ code: 'customers.buyer-account-not-found' });

  const blockers = await readBlockersAsAdmin(deps, context, accountId);
  if (!blockers.ok) return err({ code: 'customers.unavailable' });
  if (blockers.value.length > 0) {
    return err({ code: 'customers.account-deletion-blocked', blockers: blockers.value });
  }

  let created: Result<AccountDeletionRequest, AdminRequestDeletionFailure>;
  try {
    created = await deps.unitOfWork.run<AccountDeletionRequest, AdminRequestDeletionFailure>(
      market,
      async () => {
        if ((await deps.requests.findActiveOf(market, accountId)) !== null) {
          return err({ code: 'customers.account-deletion-already-requested' } as const);
        }
        // The admin step-up, spent here and only here (ADR-0018), in the unit of the request: one
        // proof serves one request, and a refusal commits nothing.
        const spent = await deps.stepUp.consume(context, BUYER_ACCOUNT_DELETE_STEP_UP);
        if (!spent.ok) return err(stepUpFailure(spent.error) as AdminRequestDeletionFailure);
        const now = deps.clock.now();
        const waitingPeriodDays = await waitingPeriodInForce(deps.accountDeletionSettings, market);
        const request: AccountDeletionRequest = {
          id: deps.ids.next<'AccountDeletionRequest'>(),
          accountId,
          status: 'pending',
          waitingPeriodDays,
          requestedAt: now,
          scheduledFor: scheduledForRequest(now, waitingPeriodDays),
          claimedAt: null,
          requestedBy: 'admin',
          adminOrigin: {
            adminAccountId: adminId,
            ticketRef: ticketRef.value,
            reason: reason.value,
          },
        };
        if (!(await deps.requests.insertPending(market, request))) {
          return err({ code: 'customers.account-deletion-already-requested' } as const);
        }
        await deps.audit.record(
          context,
          AccountDeletionRequestedByAdmin.entry(request.id, {
            after: {
              accountId,
              waitingPeriodDays,
              scheduledFor: request.scheduledFor,
              stepUpSessionId: spent.value.sessionId,
              stepUpVerifiedAt: spent.value.verifiedAt,
            },
          }),
        );
        await deps.outbox.append(context, [
          AccountDeletionRequestedByAdminEvent.record({
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
    if (isConflict(error)) return err({ code: 'customers.conflict' });
    throw error;
  }
  if (!created.ok) return err(created.error);

  // The lock: every session of the buyer ends. A refusal does not undo the request (it is
  // committed and will run); the buyer's sessions can still be ended by the next sign-out.
  const ended = await deps.identity.endCustomerSessionsForAdmin(
    context,
    accountId,
    created.value.id,
  );
  logger.log({
    msg: 'customers.admin-request-account-deletion',
    outcome: 'requested',
    sessions: ended.ok ? 'ended' : ended.error.code,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  const request = created.value;
  return ok({
    requestId: request.id,
    status: 'pending',
    requestedAt: request.requestedAt,
    scheduledFor: request.scheduledFor,
    waitingPeriodDays: request.waitingPeriodDays,
  });
}

/**
 * `DELETE customers/admin/deletion-requests/:requestId`: an admin cancels a request during the
 * wait, whoever made it (the buyer's own or an admin's). Same permission, step-up and a reason.
 * Only `pending` can be cancelled: a claimed request answers 409 in-progress, so a 204 always
 * means the account will not be erased. A closed or unknown request, or another Market's, is 404.
 * A refusal spends no proof; a cancel that conflicts with the claim answers `customers.conflict`.
 */
export async function cancelAccountDeletionForBuyer(
  deps: AccountDeletionDependencies,
  context: CallContext,
  input: { readonly requestId: unknown; readonly reason: unknown },
): Promise<Result<{ readonly code: 'cancelled' }, AdminCancelDeletionFailure>> {
  const adminId = adminActor(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const reason = parseAdminReason(input?.reason);
  if (!reason.ok) return err({ code: 'validation.failed', fields: [reason.error] });
  const parsed =
    typeof input.requestId === 'string' ? parseId<'AccountDeletionRequest'>(input.requestId) : null;
  if (parsed === null || !parsed.ok) {
    return err({ code: 'customers.account-deletion-request-not-found' });
  }
  const requestId = parsed.value;
  const { market } = context;
  try {
    return await deps.unitOfWork.run<{ readonly code: 'cancelled' }, AdminCancelDeletionFailure>(
      market,
      async () => {
        const open = await deps.requests.findById(market, requestId);
        if (open === null || (open.status !== 'pending' && open.status !== 'executing')) {
          return err({ code: 'customers.account-deletion-request-not-found' } as const);
        }
        if (open.status === 'executing') {
          return err({ code: 'customers.account-deletion-in-progress' } as const);
        }
        const spent = await deps.stepUp.consume(context, BUYER_ACCOUNT_DELETE_STEP_UP);
        if (!spent.ok) return err(stepUpFailure(spent.error) as AdminCancelDeletionFailure);
        const now = deps.clock.now();
        if (!(await deps.requests.cancelByAdmin(market, requestId, adminId, reason.value, now))) {
          // Not pending any more: claimed or closed since the read. Say which.
          const again = await deps.requests.findById(market, requestId);
          return again?.status === 'executing'
            ? err({ code: 'customers.account-deletion-in-progress' } as const)
            : err({ code: 'customers.account-deletion-request-not-found' } as const);
        }
        await deps.audit.record(
          context,
          AccountDeletionCancelledByAdmin.entry(requestId, {
            after: {
              accountId: open.accountId,
              stepUpSessionId: spent.value.sessionId,
              stepUpVerifiedAt: spent.value.verifiedAt,
            },
          }),
        );
        await deps.outbox.append(context, [
          AccountDeletionCancelledByAdminEvent.record({
            aggregateId: requestId,
            aggregateVersion: 2,
            occurredAt: now,
            payload: {},
          }),
        ]);
        return ok({ code: 'cancelled' } as const);
      },
      { isolation: 'serializable' },
    );
  } catch (error) {
    if (isConflict(error)) return err({ code: 'customers.conflict' });
    throw error;
  }
}

const encodeCursor = (cursor: PendingCursor): string =>
  `${cursor.scheduledFor.epochMilliseconds}.${cursor.id}`;

function decodeCursor(value: unknown): PendingCursor | undefined {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  if (match === null) return undefined;
  const id = parseId<'AccountDeletionRequest'>(match[2]!);
  if (!id.ok) return undefined;
  return {
    scheduledFor: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    id: id.value,
  };
}

/**
 * `GET customers/admin/deletion-requests?status=pending`: the Market's pending requests, the
 * earliest date first, a page at a time. Ids, dates and who asked: no name, email or ticket text.
 */
export async function listPendingDeletionRequests(
  deps: AccountDeletionDependencies,
  context: CallContext,
  input: { readonly status?: unknown; readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<PendingDeletionRequestPage, AdminListDeletionFailure>> {
  if (adminActor(context) === null) return err({ code: 'access.denied' });
  const fields: FieldError[] = [];
  if ((input?.status ?? 'pending') !== 'pending') fields.push({ path: 'status', code: 'format' });
  let limit = DELETION_LIST_DEFAULT_LIMIT;
  if (input?.limit !== undefined) {
    const value = input.limit;
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= DELETION_LIST_MAX_LIMIT
    ) {
      limit = value;
    } else fields.push({ path: 'limit', code: 'range' });
  }
  const after = input?.cursor === undefined ? null : decodeCursor(input.cursor);
  if (after === undefined) fields.push({ path: 'cursor', code: 'format' });
  if (fields.length > 0 || after === undefined) return err({ code: 'validation.failed', fields });
  return deps.unitOfWork.run<PendingDeletionRequestPage, AdminListDeletionFailure>(
    context.market,
    async () => {
      const rows = await deps.requests.listPending(context.market, { after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return ok({
        entries: page.map((row) => ({
          requestId: row.id,
          accountId: row.accountId,
          requestedAt: row.requestedAt,
          scheduledFor: row.scheduledFor,
          status: 'pending' as const,
          requestedBy: row.requestedBy,
        })),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ scheduledFor: last.scheduledFor, id: last.id })
            : null,
      });
    },
    { readOnly: true },
  );
}
