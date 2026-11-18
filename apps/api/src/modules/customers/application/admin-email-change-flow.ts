import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AccountDeletionRequestRepository } from './ports/account-deletion-request.repository';
import type { EmailChangePeer } from './ports/email-change-peer';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  type ListValidationFailure,
} from './customer-list-flow';
import { accountIdOf } from './customer-page-flow';

// An admin changes a customer's sign-in email (customers admin email change; design note of 16
// Nov 2026 with Mohammad's and Hassan's reviews). identity owns the account, the address, the link,
// the mails, the step-up spend and the audit; customers checks its own side first (the customer is
// not being deleted) and maps identity's answers to its route codes. The address is personal
// data: never logged here, never in an error body.

const logger = new Logger('AdminCustomerEmailChange');

/** What the two use cases need: customers' deletion requests, and identity. */
export interface EmailChangeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: AccountDeletionRequestRepository;
  readonly identity: EmailChangePeer;
}

/** The longest address a request may carry (identity's parser refuses more than 254 anyway). */
const MAX_EMAIL_LENGTH = 320;

type StepUpRefusal =
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string };

export type AdminEmailChangeRequestFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'customers.customer-not-found' }
  /** A disabled or unverified account keeps its address (identity's rule). */
  | { readonly code: 'customers.customer-not-eligible' }
  /** Another customer of the Market signs in with the address. */
  | { readonly code: 'customers.email-taken' }
  /** Hassan R6: no change is asked for while the customer's deletion request is pending. */
  | { readonly code: 'customers.account-deletion-pending' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'customers.unavailable' }
  | ListValidationFailure
  | StepUpRefusal;

export type AdminEmailChangeCancelFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'customers.customer-not-found' }
  | { readonly code: 'customers.email-change-not-found' }
  | { readonly code: 'customers.unavailable' }
  | ListValidationFailure
  | StepUpRefusal;

/** What the admin sees of a request: whether it changed anything, and when. */
export interface AdminEmailChangeRequested {
  readonly changed: boolean;
  readonly requestedAt: string | null;
}

/** A platform admin on a real admin session: R4, acting-as is refused here too. */
function plainAdmin(context: CallContext): Id<'Account'> | null {
  const admin = adminAccountOf(context);
  if (admin === null || context.actor.kind !== 'authenticated') return null;
  return context.actor.sellerId === null ? admin : null;
}

function stepUpOrNull(error: { readonly code: string; readonly actionKey?: unknown }) {
  if (
    (error.code === 'second-factor.required' ||
      error.code === 'second-factor.enrolment-required') &&
    typeof error.actionKey === 'string'
  ) {
    return { code: error.code, actionKey: error.actionKey } as StepUpRefusal;
  }
  return null;
}

/** Whether the customer has a pending deletion request (read-only unit; customers' own table). */
async function deletionPending(
  deps: EmailChangeDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<boolean, { readonly code: 'customers.unavailable' }>> {
  try {
    const read = await deps.unitOfWork.run(
      context.market,
      async () => ok((await deps.requests.findActiveOf(context.market, accountId)) !== null),
      { readOnly: true },
    );
    return read.ok ? ok(read.value) : err({ code: 'customers.unavailable' });
  } catch {
    return err({ code: 'customers.unavailable' });
  }
}

function logOutcome(context: CallContext, msg: string, accountId: string, outcome: string): void {
  logger.log({
    msg,
    outcome,
    accountId,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * `PUT customers/admin/customers/:accountId/email`. In order: the admin (not acting-as) and the
 * body (`email`, a string); the account id (malformed: not found); no pending deletion request of
 * the customer (`customers.account-deletion-pending`); then identity's request, which checks the
 * key again, parses the address, refuses a taken one, counts the mails, spends the step-up proof
 * and writes, in one unit.
 */
export async function requestEmailChange(
  deps: EmailChangeDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<AdminEmailChangeRequested, AdminEmailChangeRequestFailure>> {
  if (plainAdmin(context) === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (key !== 'accountId' && key !== 'email' && key !== 'origin') {
      return invalidField(key, 'unknown');
    }
  }
  const email = input['email'];
  if (typeof email !== 'string') return invalidField('email', 'type');
  if (email.length > MAX_EMAIL_LENGTH) return invalidField('email', 'length');
  const origin = input['origin'];
  if (typeof origin !== 'string') return err({ code: 'customers.unavailable' });
  const accountId = accountIdOf(input['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const pending = await deletionPending(deps, context, accountId);
  if (!pending.ok) return pending;
  if (pending.value) {
    logOutcome(context, 'customers.admin-customer-email-change', accountId, 'deletion-pending');
    return err({ code: 'customers.account-deletion-pending' });
  }
  const result = await deps.identity.requestCustomerEmailChangeForAdmin(context, {
    accountId,
    email,
    origin,
  });
  logOutcome(
    context,
    'customers.admin-customer-email-change',
    accountId,
    result.ok ? (result.value.changed ? 'requested' : 'unchanged') : result.error.code,
  );
  if (result.ok) {
    return ok({
      changed: result.value.changed,
      requestedAt: result.value.requestedAt === null ? null : result.value.requestedAt.toString(),
    });
  }
  const error = result.error as { readonly code: string } & Record<string, unknown>;
  const stepUp = stepUpOrNull(error);
  if (stepUp !== null) return err(stepUp);
  switch (error.code) {
    case 'validation.failed':
      // Identity names the field, never the value.
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'invalid' }] });
    case 'account.unknown':
      return err({ code: 'customers.customer-not-found' });
    case 'account.not-eligible':
      return err({ code: 'customers.customer-not-eligible' });
    case 'account.email-taken':
      return err({ code: 'customers.email-taken' });
    case 'request.throttled':
      return err({
        code: 'request.throttled',
        retryAfterSeconds:
          typeof error.retryAfterSeconds === 'number' ? error.retryAfterSeconds : 60,
      });
    case 'access.denied':
      return err({ code: 'access.denied' });
    default:
      return err({ code: 'customers.unavailable' });
  }
}

/**
 * `DELETE customers/admin/customers/:accountId/email-change`: the admin (not acting-as), the
 * account id, then identity's cancel (the key again, the step-up proof spent, the pending address
 * cleared and its link void, the audit row), in one unit.
 */
export async function cancelEmailChange(
  deps: EmailChangeDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<{ readonly cancelled: true }, AdminEmailChangeCancelFailure>> {
  if (plainAdmin(context) === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (key !== 'accountId') return invalidField(key, 'unknown');
  }
  const accountId = accountIdOf(input['accountId']);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const result = await deps.identity.cancelCustomerEmailChangeForAdmin(context, accountId);
  logOutcome(
    context,
    'customers.admin-customer-email-change-cancel',
    accountId,
    result.ok ? 'cancelled' : result.error.code,
  );
  if (result.ok) return ok({ cancelled: true });
  const error = result.error as { readonly code: string } & Record<string, unknown>;
  const stepUp = stepUpOrNull(error);
  if (stepUp !== null) return err(stepUp);
  switch (error.code) {
    case 'account.unknown':
      return err({ code: 'customers.customer-not-found' });
    case 'email-change.none':
      return err({ code: 'customers.email-change-not-found' });
    case 'access.denied':
      return err({ code: 'access.denied' });
    default:
      return err({ code: 'customers.unavailable' });
  }
}
