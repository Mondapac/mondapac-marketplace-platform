import { err, ok } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { isPlatformAdminActor } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CustomerPasswordResetSentByAdminAudit,
  CustomerSessionsEndedByAdminAudit,
  CustomerSignInAddressRevealedAudit,
} from '../../domain/audit';
import { OneTimeLink } from '../../domain/one-time-link';
import { sessionIsLive, type SessionRevokedReason } from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { SessionRepository } from '../ports/session.repository';
import {
  customerSignInResultOf,
  type CustomerSignInQuery,
  type SignInRecordRepository,
} from '../ports/sign-in-record.repository';
import type {
  AdminPasswordResetFailure,
  CustomerSecurityFailure,
  CustomerSessionFact,
  CustomerSessionsView,
  CustomerSignInFact,
  CustomerSignInsPage,
  CustomerSignInsRequest,
} from '../../contracts/customer-security';

export type {
  AdminPasswordResetFailure,
  CustomerSecurityFailure,
  CustomerSessionFact,
  CustomerSessionsView,
  CustomerSignInFact,
  CustomerSignInsPage,
  CustomerSignInsRequest,
};

// A customer's security section on the admin customer page (customers management phase 2b): the
// sign-ins of the last 90 days, the live sessions, the reveal of one sign-in's full address,
// "sign out everywhere" and "send password reset". An auth path: every entry point refuses an
// actor that is not a platform admin, a seller-scoped actor and an acting-as session, whatever
// its keys; only customer accounts and customer-population records are ever read or changed; the
// address leaves only through the reveal, which audits it in the unit that read it. Nothing here
// is over HTTP: `customers` composes it through the facade and writes the timeline entries.

/** How far back the customer page shows sign-ins (the records are kept for 90 days). */
export const CUSTOMER_SIGN_IN_DAYS = 90;

/** At most this many rows in one call (the export's cap plus the overflow row). */
export const CUSTOMER_SIGN_INS_MAX_WINDOW = 10_001;

/** The most live sessions the section lists; `more` says that there are others. */
export const CUSTOMER_SESSIONS_LIMIT = 50;

/**
 * An admin cannot send a customer a second reset mail within this many minutes of the last
 * request (the customer's own or an admin's): one mail is enough, and a mailbox is not flooded.
 */
export const ADMIN_RESET_INTERVAL_MINUTES = 5;

export interface CustomerSecurityDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly records: SignInRecordRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

export interface CustomerPasswordResetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const ninetyDaysBefore = (now: Temporal.Instant): Temporal.Instant =>
  now.subtract({ hours: 24 * CUSTOMER_SIGN_IN_DAYS });

// ---- sign-ins --------------------------------------------------------------------------------

/** One page of a customer's sign-ins of the last 90 days, newest first by default. */
export async function readCustomerSignIns(
  deps: CustomerSecurityDependencies,
  context: CallContext,
  request: CustomerSignInsRequest,
): Promise<Result<CustomerSignInsPage, CustomerSecurityFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const now = deps.clock.now();
  const since = ninetyDaysBefore(now);
  const from =
    request.from === null || request.from.epochMilliseconds < since.epochMilliseconds
      ? since
      : request.from;
  const query: CustomerSignInQuery = {
    accountId: request.accountId,
    results: request.results,
    from,
    to: request.to,
  };
  const limit = Math.min(Math.max(request.window.limit, 0), CUSTOMER_SIGN_INS_MAX_WINDOW);
  const offset = Math.max(request.window.offset, 0);
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const [rows, total] = await Promise.all([
        deps.records.pageOfCustomer(context.market, query, request.direction, { offset, limit }),
        request.withTotal
          ? deps.records.countOfCustomer(context.market, query)
          : Promise.resolve(null),
      ]);
      return ok({ rows, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({
    rows: read.value.rows.map((row) => ({
      signInId: row.id,
      occurredAt: row.occurredAt.toString(),
      outcome: row.outcome,
      result: customerSignInResultOf(row.outcome),
      device: row.device,
      city: null,
    })),
    total: read.value.total,
    since: since.toString(),
  });
}

/**
 * The full client address of one of the customer's sign-ins of the last 90 days. One unit reads
 * it and writes the audit row (the record id, never the address); the address is answered only
 * after that unit committed. Another account's record, another population's and an older one are
 * `account.unknown` alike.
 */
export async function revealCustomerSignInAddress(
  deps: CustomerSecurityDependencies,
  context: CallContext,
  input: { readonly accountId: Id<'Account'>; readonly signInId: Id<'SignInRecord'> },
): Promise<
  Result<{ readonly address: string; readonly occurredAt: string }, CustomerSecurityFailure>
> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const since = ninetyDaysBefore(deps.clock.now());
  return deps.unitOfWork.run<
    { readonly address: string; readonly occurredAt: string },
    CustomerSecurityFailure
  >(context.market, async () => {
    const found = await deps.records.customerAddressOf(
      context.market,
      input.accountId,
      input.signInId,
      since,
    );
    if (found === null) return err({ code: 'account.unknown' });
    await deps.audit.record(
      context,
      CustomerSignInAddressRevealedAudit.entry(input.accountId, {
        after: { signInId: input.signInId },
      }),
    );
    return ok({ address: found.address, occurredAt: found.occurredAt.toString() });
  });
}

// ---- sessions --------------------------------------------------------------------------------

/** The customer's live sessions, most recently used first, at most 50. */
export async function readCustomerSessions(
  deps: CustomerSecurityDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<CustomerSessionsView, CustomerSecurityFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const now = deps.clock.now();
  const read = await deps.unitOfWork.run<
    readonly CustomerSessionFact[] | null,
    CustomerSecurityFailure
  >(
    context.market,
    async () => {
      const account = await deps.accounts.findById(context.market, accountId);
      if (account === null || account.state.population !== 'customer') return ok(null);
      const sessions = await deps.sessions.listUnrevokedOf(
        context.market,
        accountId,
        now,
        CUSTOMER_SESSIONS_LIMIT + 1,
      );
      return ok(
        sessions
          .filter((session) => sessionIsLive(session, now))
          .map((session) => ({
            device: session.device,
            signedInAt: session.createdAt.toString(),
            lastActiveAt: session.lastSeenAt.toString(),
          })),
      );
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  if (read.value === null) return err({ code: 'account.unknown' });
  return ok({
    items: read.value.slice(0, CUSTOMER_SESSIONS_LIMIT),
    more: read.value.length > CUSTOMER_SESSIONS_LIMIT,
  });
}

/**
 * Ends every session of a customer account in one unit that takes the account's credential lock
 * first (as a password reset does), and writes the audit row the caller builds from the count.
 * Answers null when the account is not a customer account of the Market. Shared by the admin's
 * "sign out everywhere" and the deletion request's ending of the sessions.
 */
export async function endEveryCustomerSession(
  deps: Pick<
    CustomerSecurityDependencies,
    'unitOfWork' | 'accounts' | 'sessions' | 'audit' | 'clock'
  >,
  context: CallContext,
  accountId: Id<'Account'>,
  reason: SessionRevokedReason,
  entry: (revokedSessions: number) => AuditEntry,
): Promise<number | null> {
  const { market } = context;
  const ended = await deps.unitOfWork.run<number | null, never>(market, async () => {
    if (!(await deps.accounts.lockCredential(market, accountId))) return ok(null);
    const account = await deps.accounts.findById(market, accountId);
    if (account === null || account.state.population !== 'customer') return ok(null);
    const revoked = await deps.sessions.revokeAllOf(
      market,
      accountId,
      reason,
      deps.clock.now(),
      null,
    );
    await deps.audit.record(context, entry(revoked));
    return ok(revoked);
  });
  return ended.ok ? ended.value : null;
}

/** "Sign out everywhere": ends every session of the customer account. Audited with the count. */
export async function signOutCustomerEverywhere(
  deps: CustomerSecurityDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<{ readonly revokedSessions: number }, CustomerSecurityFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const revoked = await endEveryCustomerSession(
    deps,
    context,
    accountId,
    'admin-signed-out',
    (revokedSessions) =>
      CustomerSessionsEndedByAdminAudit.entry(accountId, { after: { revokedSessions } }),
  );
  return revoked === null ? err({ code: 'account.unknown' }) : ok({ revokedSessions: revoked });
}

// ---- password reset ---------------------------------------------------------------------------

/**
 * Sends the customer the password reset mail, as "Forgot password?" does for them: the account's
 * `reset-password` link is requested (again; an earlier token stops working) and
 * `identity.one-time-link-requested.v1` is recorded, so the mail handler mints the token and sends
 * E8 to the customer's own verified address. The admin never sees a token or a link. One unit with
 * the audit row. Only an active, verified customer account; not twice within five minutes.
 */
export async function sendCustomerPasswordReset(
  deps: CustomerPasswordResetDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<{ readonly sent: true }, AdminPasswordResetFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const { market } = context;
  const now = deps.clock.now();
  try {
    return await deps.unitOfWork.run<{ readonly sent: true }, AdminPasswordResetFailure>(
      market,
      async () => {
        const account = await deps.accounts.findById(market, accountId);
        if (account === null || account.state.population !== 'customer') {
          return err({ code: 'account.unknown' });
        }
        if (!account.isEmailVerified || account.state.status !== 'active') {
          return err({ code: 'account.not-eligible' });
        }
        const found = await deps.links.findFor(market, accountId, 'reset-password');
        let link: OneTimeLink;
        if (found === null) {
          link = OneTimeLink.request({
            id: deps.ids.next<'OneTimeLink'>(),
            marketId: market.marketId,
            accountId,
            purpose: 'reset-password',
            now,
            notify: true,
          });
          await deps.links.add(market, link);
        } else {
          const recent = found.state.requestedAt.add({ minutes: ADMIN_RESET_INTERVAL_MINUTES });
          if (now.epochMilliseconds < recent.epochMilliseconds) {
            return err({ code: 'password-reset.recently-requested' });
          }
          link = found;
          link.requestAgain(now, true);
          await deps.links.save(market, link);
        }
        await deps.outbox.append(context, link.pendingEvents);
        await deps.audit.record(
          context,
          CustomerPasswordResetSentByAdminAudit.entry(accountId, {
            after: { linkId: link.state.id },
          }),
        );
        return ok({ sent: true as const });
      },
    );
  } catch (error) {
    // A concurrent request renewed the same link first: its mail goes, this one is the repeat.
    if (error instanceof StaleAggregateError) {
      return err({ code: 'password-reset.recently-requested' });
    }
    throw error;
  }
}
