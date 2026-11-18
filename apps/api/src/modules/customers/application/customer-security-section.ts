import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  MAX_PAGED_ROWS,
  parseClosedValues,
  parseInstantRange,
  type InstantRange,
} from '../../../platform/list-query';
import {
  CUSTOMER_SIGN_IN_RESULTS,
  type CustomerSignInFact,
  type CustomerSignInResult,
} from '../../identity';
import type { TimelineKind } from '../domain/customer-timeline';
import { admitAdminAction, type AdminActionRefusal } from './admin-action-limits';
import {
  customerOf,
  fromOwner,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
  type SectionListSpec,
} from './customer-section-lists';
import { adminAccountOf, invalidField, isRecord } from './customer-list-flow';
import type { AdminLimitedAction } from './ports/admin-action-limits';

// The customer page's security section (phase 2b): the sign-ins of the last 90 days as a super
// list, the reveal of one sign-in's full address, the live sessions, "sign out everywhere" and
// "send password reset". identity owns all of it and audits every reveal and action in its own
// unit; customers composes it and adds the timeline entry. An auth path: every refusal of identity
// is kept a refusal here, and the address is answered only after its timeline entry is written.

export type CustomerSecurityFailure =
  | CustomerSectionFailure
  | AdminActionRefusal
  | { readonly code: 'customers.sign-in-not-found' }
  | { readonly code: 'customers.customer-not-eligible' }
  | { readonly code: 'customers.password-reset-recently-requested' };

const logger = new Logger('CustomerSecuritySection');

interface SignInFilters extends InstantRange {
  readonly results: readonly CustomerSignInResult[] | null;
}

/** The sign-ins of the last 90 days: time, outcome, result and device; never the address. */
export const SIGN_INS_SECTION: SectionListSpec<SignInFilters, 'occurred', CustomerSignInFact> = {
  section: 'sign-ins',
  filterKeys: ['result', 'from', 'to'],
  parseFilters: (raw) => {
    const results = parseClosedValues(raw['result'], CUSTOMER_SIGN_IN_RESULTS, 'filters.result');
    if (!results.ok) return results;
    const range = parseInstantRange(raw);
    if (!range.ok) return range;
    return ok({ results: results.value, ...range.value });
  },
  query: {
    sorts: ['occurred'],
    defaultSort: 'occurred',
    defaultPageSize: 25,
    maxPageSize: 100,
    maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
  },
  read: async (peers, context, request) => {
    const read = await peers.identity.adminCustomerSignIns(context, {
      accountId: request.accountId,
      results: request.filters.results,
      from: request.filters.from,
      to: request.filters.to,
      direction: request.direction,
      window: request.window,
      withTotal: request.withTotal,
    });
    if (!read.ok) return read;
    return ok({
      rows: read.value.rows,
      total: read.value.total,
      extra: { since: read.value.since },
    });
  },
  sheet: {
    baseName: 'customer-sign-ins',
    name: 'Sign-ins',
    header: ['Sign-in', 'Occurred at', 'Result', 'Outcome', 'Device'],
    cells: (row) => [row.signInId, row.occurredAt, row.result, row.outcome, row.device],
  },
};

/** identity's refusal of an account as the customer page answers it. */
function fromIdentity(code: string): CustomerSecurityFailure {
  switch (code) {
    case 'account.unknown':
      return { code: 'customers.customer-not-found' };
    case 'account.not-eligible':
      return { code: 'customers.customer-not-eligible' };
    case 'password-reset.recently-requested':
      return { code: 'customers.password-reset-recently-requested' };
    default:
      return fromOwner(code);
  }
}

/** Writes one admin-action entry on the customer's timeline; answers whether it was written. */
async function noteOnTimeline(
  deps: CustomerSectionDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  accountId: Id<'Account'>,
  kind: TimelineKind,
  detail: string | null,
): Promise<boolean> {
  const now = deps.clock.now();
  try {
    const written = await deps.unitOfWork.run(context.market, async () => {
      await deps.timeline.record(
        context.market,
        {
          id: deps.ids.next<'CustomerTimelineEntry'>(),
          accountId,
          occurredAt: now,
          kind,
          ref: null,
          actorAccountId: admin,
          detail,
          sourceEventId: null,
        },
        now,
      );
      return ok(true);
    });
    return written.ok;
  } catch {
    return false;
  }
}

function closedInput(
  input: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, CustomerSecurityFailure> {
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return invalidField(key, 'unknown');
  }
  return ok(input);
}

/**
 * Reveals the full address of one of the customer's sign-ins. identity reads it and writes the
 * audit row in one unit; then the timeline entry `sign-in-address-revealed` is written, and only
 * if it was is the address answered (a reveal that cannot be put on the timeline shows nothing).
 */
export async function revealSignInAddress(
  deps: CustomerSectionDependencies,
  context: CallContext,
  input: unknown,
): Promise<
  Result<
    { readonly signInId: string; readonly address: string; readonly occurredAt: string },
    CustomerSecurityFailure
  >
> {
  const closed = closedInput(input, ['accountId', 'signInId']);
  if (!closed.ok) return closed;
  const me = adminAccountOf(context);
  if (me === null) return err({ code: 'access.denied' });
  // Counted with the address reveal (security review of #969, L3), before anything is read.
  const admitted = await admitAdminAction(
    deps,
    context,
    me,
    'pii-reveal',
    'customers.admin-customer-sign-in-reveal',
  );
  if (!admitted.ok) return admitted;
  const customer = await customerOf(deps, context, closed.value['accountId']);
  if (!customer.ok) return customer;
  const { admin, accountId } = customer.value;
  const raw = closed.value['signInId'];
  const parsed = typeof raw === 'string' ? parseId<'SignInRecord'>(raw) : null;
  if (parsed === null || !parsed.ok) return err({ code: 'customers.sign-in-not-found' });
  const signInId = parsed.value;
  const revealed = await deps.peers.identity.adminRevealCustomerSignIn(context, {
    accountId,
    signInId,
  });
  if (!revealed.ok) {
    return err(
      revealed.error.code === 'account.unknown'
        ? { code: 'customers.sign-in-not-found' }
        : fromIdentity(revealed.error.code),
    );
  }
  if (
    !(await noteOnTimeline(deps, context, admin, accountId, 'sign-in-address-revealed', 'sign-in'))
  ) {
    logger.warn({
      msg: 'customers.admin-customer-sign-in-reveal',
      code: 'timeline-not-written',
      accountId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
  return ok({ signInId, address: revealed.value.address, occurredAt: revealed.value.occurredAt });
}

/** The customer's live sessions (device and times), at most 50. */
export async function readSessions(
  deps: CustomerSectionDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<unknown, CustomerSecurityFailure>> {
  const closed = closedInput(input, ['accountId']);
  if (!closed.ok) return closed;
  const customer = await customerOf(deps, context, closed.value['accountId']);
  if (!customer.ok) return customer;
  const read = await deps.peers.identity.adminCustomerSessions(context, customer.value.accountId);
  return read.ok ? ok(read.value) : err(fromIdentity(read.error.code));
}

/**
 * An account action of identity (sign out everywhere, send password reset), then its timeline
 * entry. identity has done and audited the action when it answers; a timeline entry that cannot
 * be written is logged (ids only) and the action's answer stands.
 */
async function accountAction<T>(
  deps: CustomerSectionDependencies,
  context: CallContext,
  input: unknown,
  name: string,
  kind: TimelineKind,
  act: (accountId: Id<'Account'>) => Promise<Result<T, { readonly code: string }>>,
  limited: AdminLimitedAction | null = null,
): Promise<Result<T, CustomerSecurityFailure>> {
  const closed = closedInput(input, ['accountId']);
  if (!closed.ok) return closed;
  if (limited !== null) {
    // Counted per admin (security review of #969, L2), before the customer is looked up.
    const me = adminAccountOf(context);
    if (me === null) return err({ code: 'access.denied' });
    const admitted = await admitAdminAction(deps, context, me, limited, name);
    if (!admitted.ok) return admitted;
  }
  const customer = await customerOf(deps, context, closed.value['accountId']);
  if (!customer.ok) return customer;
  const { admin, accountId } = customer.value;
  const done = await act(accountId);
  if (!done.ok) return err(fromIdentity(done.error.code));
  if (!(await noteOnTimeline(deps, context, admin, accountId, kind, null))) {
    logger.warn({
      msg: name,
      code: 'timeline-not-written',
      accountId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
  return ok(done.value);
}

/** "Sign out everywhere": identity ends every session of the customer and audits the count. */
export function signOutEverywhere(
  deps: CustomerSectionDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<{ readonly revokedSessions: number }, CustomerSecurityFailure>> {
  return accountAction(
    deps,
    context,
    input,
    'customers.admin-customer-sign-out',
    'signed-out-by-admin',
    (accountId) => deps.peers.identity.adminSignOutCustomer(context, accountId),
  );
}

/** "Send password reset": identity requests the reset mail to the customer's own address. */
export function sendPasswordReset(
  deps: CustomerSectionDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<{ readonly sent: true }, CustomerSecurityFailure>> {
  return accountAction(
    deps,
    context,
    input,
    'customers.admin-customer-password-reset',
    'password-reset-sent',
    (accountId) => deps.peers.identity.adminSendCustomerPasswordReset(context, accountId),
    'password-reset',
  );
}
