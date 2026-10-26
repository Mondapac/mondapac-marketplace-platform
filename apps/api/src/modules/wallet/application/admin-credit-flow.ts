import { createHash } from 'node:crypto';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpRefusal } from '../../../platform/authz';
import { WALLET_CREDIT_APPROVE_STEP_UP, WALLET_CREDIT_ISSUE_STEP_UP } from '../contracts/step-up';
import type { WalletFailure } from '../contracts/wallet.facade';
import {
  approvalNeeded,
  isAdminCreditReason,
  isPastExpiry,
  isRejectReason,
  localDayOf,
  normalisedNote,
  requestExpiry,
  type AdminCreditReason,
  type AdminCreditRejectReason,
  type AdminCreditStatus,
  type ApprovalReason,
} from '../domain/admin-credit';
import {
  AdminCreditApproved,
  AdminCreditExpired,
  AdminCreditIssued,
  AdminCreditRejected,
  AdminCreditRequested,
} from '../domain/audit';
import { refusalFor, type WalletStatus } from '../domain/wallet-status';
import type { AdminCreditRecord } from './ports/admin-credit.repository';
import { isActingAs } from './settings-flow';
import type { AdminCreditDependencies } from './wallet-dependencies';
import {
  amountProblem,
  databaseErrorOf,
  gate,
  grantInUnit,
  idOf,
  isStatusFence,
  keyOk,
  type GrantPlan,
} from './wallet-flow';

// Admin credit issuance with maker-checker (customer wallet package 2a). An admin issues promo
// credit (cost always the platform's, expiry as any promo lot) to a customer with a closed reason
// code. Within the Market's caps (per issue, and per admin per calendar day in the Market's zone,
// counting what the admin was granted, has pending and had approved that day) it is granted at
// once through the ledger; above either cap it becomes a pending request with no ledger effect,
// which a second, different admin approves (the grant then happens, with the wallet state, the
// customer wallet and the balance cap checked again) or rejects, or which expires.
//
// Every write is refused in an acting-as session and spends a fresh admin step-up proof of its own
// action, inside the unit that writes, right before the first write: one verified code moves money
// once (issue #491; as `setStatus`). A refusal before that point spends nothing.
//
// The daily cap is race-safe: an issue first locks the admin's day row, so two issues by one
// admin on one day run one after the other and the second counts the first.
//
// The customer id is checked through identity's facade (review S1): issue, approve and the
// customer read answer `wallet.customer-not-found` unless it names an active customer account of
// the context's Market. Units do not nest, so the check runs just before the write unit; the race
// accepted is an account closed between the check and the unit's commit (milliseconds): the credit
// then sits on a closed account, where nobody can spend it, and the audit row names it.

export type AdminCreditFailure =
  | WalletFailure
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'wallet.credit-request-not-found' }
  /** The request was already approved, rejected or expired. */
  | { readonly code: 'wallet.credit-request-decided' }
  /** The request is past its expiry; the sweep marks it expired. */
  | { readonly code: 'wallet.credit-request-expired' }
  /** Maker-checker: the admin who asked cannot decide. */
  | { readonly code: 'wallet.approver-is-requester' }
  /**
   * The id names no active customer account of this Market: unknown, a seller or an admin, another
   * Market's, or closed, alike. Nothing was spent or written.
   */
  | { readonly code: 'wallet.customer-not-found' };

export interface AdminCreditView {
  readonly id: Id<'WalletCreditRequest'>;
  readonly customerAccountId: Id<'Account'>;
  readonly amount: bigint;
  readonly currency: string;
  readonly reasonCode: AdminCreditReason;
  readonly note: string | null;
  readonly status: AdminCreditStatus;
  readonly approvalReason: ApprovalReason | null;
  readonly requestedBy: Id<'Account'>;
  readonly requestedAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant | null;
  readonly decidedBy: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly decisionReason: AdminCreditRejectReason | null;
  readonly journalId: Id<'WalletJournal'> | null;
}

export interface IssueAdminCreditInput {
  readonly customerAccountId: unknown;
  readonly amount: unknown;
  readonly reasonCode: unknown;
  readonly note?: unknown;
  readonly idempotencyKey: unknown;
}

type Problem = { path: string; code: string };

const invalid = (fields: readonly Problem[]): AdminCreditFailure => ({
  code: 'validation.failed',
  fields,
});

const viewOf = (row: AdminCreditRecord): AdminCreditView => ({
  id: row.id,
  customerAccountId: row.customerAccountId,
  amount: row.amountMinor,
  currency: row.currency,
  reasonCode: row.reasonCode,
  note: row.note,
  status: row.status,
  approvalReason: row.approvalReason,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt,
  expiresAt: row.expiresAt,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt,
  decisionReason: row.decisionReason,
  journalId: row.journalId,
});

/**
 * The admin who acts, or null when the caller is not an admin or acts as someone else. Reads and
 * writes alike: an acting-as session sees no customer's wallet nor the request queue (review S4).
 */
function signedInAdmin(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    return null;
  }
  return actor.accountId;
}

/**
 * Whether `customer` is an active customer account of the context's Market, asked of identity's
 * facade (review S1). A miss is `wallet.customer-not-found`; a refusal or a failed call fails
 * closed (`access.denied` passed on, anything else `access.unavailable`).
 */
async function customerCheck(
  deps: AdminCreditDependencies,
  context: CallContext,
  customer: Id<'Account'>,
): Promise<AdminCreditFailure | null> {
  try {
    const found = await deps.identity.customerAccountOf(context, customer);
    if (!found.ok) {
      return {
        code: found.error.code === 'access.denied' ? 'access.denied' : 'access.unavailable',
      };
    }
    return found.value?.accountId === customer ? null : { code: 'wallet.customer-not-found' };
  } catch {
    return { code: 'access.unavailable' };
  }
}

/**
 * The idempotency fingerprint of an issue: a SHA-256 (hex) of the joined fields, so the stored
 * column never holds the free-text note (review S2).
 */
export function issueFingerprint(fields: readonly (string | bigint)[]): string {
  return createHash('sha256').update(fields.join('|'), 'utf8').digest('hex');
}

/** identity's refusal of the step-up, as these use cases answer it; anything else stays closed. */
function stepUpFailure(refusal: StepUpRefusal): AdminCreditFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

/** The ledger key of the grant of request `id`: derived on the server, never the client's key. */
export const journalKeyOf = (id: Id<'WalletCreditRequest'>): string => `wallet:admin-credit:${id}`;

const grantPlanOf = (
  row: Pick<AdminCreditRecord, 'id' | 'customerAccountId' | 'amountMinor' | 'reasonCode'>,
  now: Temporal.Instant,
  policy: GrantPlan['policy'],
): GrantPlan => ({
  customer: row.customerAccountId,
  source: 'promo',
  amount: row.amountMinor,
  reasonCode: row.reasonCode,
  orderId: null,
  idempotencyKey: journalKeyOf(row.id),
  fingerprint: `admin-credit|${row.id}`,
  now,
  policy,
});

/** A unique violation on the request's idempotency key: 23505 on an admin credit request. */
const isRequestKeyConflict = (error: unknown): boolean => {
  const { model, sqlState } = databaseErrorOf(error);
  return model === 'WalletAdminCreditRequest' && sqlState === '23505';
};

const isFence = (error: unknown): boolean =>
  isStatusFence(error) || isStatusFence(error, 'WalletAdminCreditRequest');

/**
 * Runs a write unit; a refusal by the status fence (an admin switched the Market between the gate
 * and the insert) runs it once more, where the gate now sees the new status.
 */
async function fenced<T>(
  attempt: () => Promise<Result<T, AdminCreditFailure>>,
  onKeyConflict?: () => Promise<Result<T, AdminCreditFailure>>,
): Promise<Result<T, AdminCreditFailure>> {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (onKeyConflict !== undefined && isRequestKeyConflict(error)) return onKeyConflict();
      if (isFence(error) && tries === 0) continue;
      throw error;
    }
  }
}

/** `IssueAdminCredit`: grants at once within both caps, else files a pending request. */
export async function issueAdminCredit(
  deps: AdminCreditDependencies,
  context: CallContext,
  input: IssueAdminCreditInput,
): Promise<Result<AdminCreditView, AdminCreditFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });

  const problems: Problem[] = [];
  const customer = idOf<'Account'>(input?.customerAccountId);
  if (customer === null) problems.push({ path: 'customerAccountId', code: 'format' });
  const amount = input?.amount as Money | undefined;
  if (amountProblem(amount, policy.currency)) problems.push({ path: 'amount', code: 'range' });
  const reasonCode = input?.reasonCode;
  if (!isAdminCreditReason(reasonCode)) problems.push({ path: 'reasonCode', code: 'value' });
  const note = normalisedNote(input?.note);
  if (!note.ok) problems.push({ path: 'note', code: note.code });
  const key = input?.idempotencyKey;
  if (!keyOk(key)) problems.push({ path: 'idempotencyKey', code: 'format' });
  if (
    problems.length > 0 ||
    customer === null ||
    amount === undefined ||
    !isAdminCreditReason(reasonCode) ||
    !note.ok ||
    !keyOk(key)
  ) {
    return err(invalid(problems));
  }

  const fingerprint = issueFingerprint([
    'admin-credit',
    admin,
    customer,
    amount.amount,
    amount.currency,
    reasonCode,
    note.note ?? '',
  ]);
  // Before the unit, so a miss spends no step-up proof and writes nothing.
  const unknownCustomer = await customerCheck(deps, context, customer);
  if (unknownCustomer !== null) return err(unknownCustomer);
  const now = deps.clock.now();
  const localDay = localDayOf(now, policy.timeZone);
  const replay = (known: AdminCreditRecord): Result<AdminCreditView, AdminCreditFailure> =>
    known.fingerprint === fingerprint ? ok(viewOf(known)) : err({ code: 'idempotency.key-reused' });

  const attempt = () =>
    deps.unitOfWork.run<AdminCreditView, AdminCreditFailure>(context.market, async () => {
      // The day lock first: everything below, the count included, runs one issue at a time.
      await deps.credits.lockDay(context.market, admin, localDay, now);
      const known = await deps.credits.findByKey(context.market, key);
      if (known !== null) return replay(known);
      const closed = await gate(deps, context, 'grant');
      if (closed !== null) return err(closed);
      const usedToday = await deps.credits.countedOnDay(context.market, admin, localDay);
      const approvalReason = approvalNeeded({
        amount: amount.amount,
        usedToday,
        issueCap: policy.adminIssueCapMinor,
        dailyCap: policy.adminDailyCapMinor,
      });
      const id = deps.ids.next<'WalletCreditRequest'>();
      const base = {
        id,
        customerAccountId: customer,
        amountMinor: amount.amount,
        currency: policy.currency,
        reasonCode,
        note: note.note,
        requestedBy: admin,
        requestedAt: now,
        localDay,
        idempotencyKey: key,
        fingerprint,
      };

      if (approvalReason !== null) {
        const spent = await deps.stepUp.consume(context, WALLET_CREDIT_ISSUE_STEP_UP);
        if (!spent.ok) return err(stepUpFailure(spent.error));
        const expiresAt = requestExpiry(now, policy.adminRequestExpiryDays, policy.timeZone);
        const record: AdminCreditRecord = {
          ...base,
          status: 'pending',
          approvalReason,
          expiresAt,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          journalId: null,
        };
        await deps.credits.create(context.market, record);
        await deps.audit.record(
          context,
          AdminCreditRequested.entry(id, {
            after: {
              customerAccountId: customer,
              amount,
              reasonCode,
              status: 'pending',
              approvalReason,
              expiresAt,
              stepUpSessionId: spent.value.sessionId,
              stepUpVerifiedAt: spent.value.verifiedAt,
            },
          }),
        );
        return ok(viewOf(record));
      }

      let proof: ConsumedStepUp | null = null;
      const granted = await grantInUnit<AdminCreditFailure>(
        deps,
        context,
        grantPlanOf(base, now, policy),
        async () => {
          const spent = await deps.stepUp.consume(context, WALLET_CREDIT_ISSUE_STEP_UP);
          if (!spent.ok) return stepUpFailure(spent.error);
          proof = spent.value;
          return null;
        },
      );
      if (!granted.ok) return granted;
      const spent = proof as ConsumedStepUp | null;
      if (spent === null) return err({ code: 'access.denied' });
      const record: AdminCreditRecord = {
        ...base,
        status: 'granted',
        approvalReason: null,
        expiresAt: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        journalId: granted.value.journalId,
      };
      await deps.credits.create(context.market, record);
      await deps.audit.record(
        context,
        AdminCreditIssued.entry(id, {
          after: {
            customerAccountId: customer,
            amount,
            reasonCode,
            status: 'granted',
            journalId: granted.value.journalId,
            stepUpSessionId: spent.sessionId,
            stepUpVerifiedAt: spent.verifiedAt,
          },
        }),
      );
      return ok(viewOf(record));
    });

  // Two admins with one key meet in the unique index: answered from the first request.
  const keyConflict = () =>
    deps.unitOfWork.run<AdminCreditView, AdminCreditFailure>(
      context.market,
      async () => {
        const known = await deps.credits.findByKey(context.market, key);
        return known === null ? err({ code: 'wallet.unavailable' } as const) : replay(known);
      },
      { readOnly: true },
    );
  return fenced(attempt, keyConflict);
}

/** The pending request, locked, that `admin` may decide now; or the refusal. */
async function decidable(
  deps: AdminCreditDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  id: Id<'WalletCreditRequest'>,
  now: Temporal.Instant,
): Promise<Result<AdminCreditRecord, AdminCreditFailure>> {
  const row = await deps.credits.findForUpdate(context.market, id);
  if (row === null) return err({ code: 'wallet.credit-request-not-found' });
  if (row.status !== 'pending') return err({ code: 'wallet.credit-request-decided' });
  if (row.requestedBy === admin) return err({ code: 'wallet.approver-is-requester' });
  if (isPastExpiry(row.expiresAt, now)) return err({ code: 'wallet.credit-request-expired' });
  return ok(row);
}

const requestIdOf = (value: unknown): Id<'WalletCreditRequest'> | null =>
  idOf<'WalletCreditRequest'>(value);

/** `ApproveAdminCredit`: a second admin approves; the credit is granted in the same unit. */
export async function approveAdminCredit(
  deps: AdminCreditDependencies,
  context: CallContext,
  input: { readonly requestId: unknown },
): Promise<Result<AdminCreditView, AdminCreditFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const id = requestIdOf(input?.requestId);
  if (id === null) return err(invalid([{ path: 'requestId', code: 'format' }]));
  const now = deps.clock.now();

  // The customer again, before the unit (units do not nest). The request's customer never changes
  // (a trigger fences it), so reading it first is safe. A miss leaves the request pending and
  // spends nothing: a checker may reject it (`wrong-customer`) or it expires.
  const seen = await deps.unitOfWork.run<AdminCreditRecord | null, AdminCreditFailure>(
    context.market,
    async () => ok(await deps.credits.find(context.market, id)),
    { readOnly: true },
  );
  if (!seen.ok) return seen;
  if (seen.value === null) return err({ code: 'wallet.credit-request-not-found' });
  if (seen.value.status === 'pending') {
    const unknownCustomer = await customerCheck(deps, context, seen.value.customerAccountId);
    if (unknownCustomer !== null) return err(unknownCustomer);
  }

  const attempt = () =>
    deps.unitOfWork.run<AdminCreditView, AdminCreditFailure>(context.market, async () => {
      const found = await decidable(deps, context, admin, id, now);
      if (!found.ok) return found;
      const row = found.value;
      if (row.currency !== policy.currency) return err({ code: 'wallet.unavailable' });
      let proof: ConsumedStepUp | null = null;
      // The wallet state, the customer wallet and the balance cap are checked again here.
      const granted = await grantInUnit<AdminCreditFailure>(
        deps,
        context,
        grantPlanOf(row, now, policy),
        async () => {
          const spent = await deps.stepUp.consume(context, WALLET_CREDIT_APPROVE_STEP_UP);
          if (!spent.ok) return stepUpFailure(spent.error);
          proof = spent.value;
          return null;
        },
      );
      if (!granted.ok) return granted;
      const spent = proof as ConsumedStepUp | null;
      if (spent === null) return err({ code: 'access.denied' });
      const decided = await deps.credits.decide(context.market, id, {
        status: 'approved',
        decidedBy: admin,
        decidedAt: now,
        decisionReason: null,
        journalId: granted.value.journalId,
      });
      if (!decided) throw new Error('wallet.admin-credit: a locked pending request changed');
      await deps.audit.record(
        context,
        AdminCreditApproved.entry(id, {
          before: { status: 'pending' },
          after: {
            status: 'approved',
            requestedBy: row.requestedBy,
            customerAccountId: row.customerAccountId,
            amount: { amount: row.amountMinor, currency: row.currency },
            journalId: granted.value.journalId,
            stepUpSessionId: spent.sessionId,
            stepUpVerifiedAt: spent.verifiedAt,
          },
        }),
      );
      return ok(
        viewOf({
          ...row,
          status: 'approved',
          decidedBy: admin,
          decidedAt: now,
          journalId: granted.value.journalId,
        }),
      );
    });
  return fenced(attempt);
}

/** `RejectAdminCredit`: a second admin rejects with a closed reason; no money moves. */
export async function rejectAdminCredit(
  deps: AdminCreditDependencies,
  context: CallContext,
  input: { readonly requestId: unknown; readonly reasonCode: unknown },
): Promise<Result<AdminCreditView, AdminCreditFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const problems: Problem[] = [];
  const id = requestIdOf(input?.requestId);
  if (id === null) problems.push({ path: 'requestId', code: 'format' });
  const reason = input?.reasonCode;
  if (!isRejectReason(reason)) problems.push({ path: 'reasonCode', code: 'value' });
  if (problems.length > 0 || id === null || !isRejectReason(reason)) return err(invalid(problems));
  const now = deps.clock.now();

  return deps.unitOfWork.run<AdminCreditView, AdminCreditFailure>(context.market, async () => {
    const found = await decidable(deps, context, admin, id, now);
    if (!found.ok) return found;
    const row = found.value;
    const spent = await deps.stepUp.consume(context, WALLET_CREDIT_APPROVE_STEP_UP);
    if (!spent.ok) return err(stepUpFailure(spent.error));
    const decided = await deps.credits.decide(context.market, id, {
      status: 'rejected',
      decidedBy: admin,
      decidedAt: now,
      decisionReason: reason,
      journalId: null,
    });
    if (!decided) throw new Error('wallet.admin-credit: a locked pending request changed');
    await deps.audit.record(
      context,
      AdminCreditRejected.entry(id, {
        before: { status: 'pending' },
        after: {
          status: 'rejected',
          requestedBy: row.requestedBy,
          reasonCode: reason,
          stepUpSessionId: spent.value.sessionId,
          stepUpVerifiedAt: spent.value.verifiedAt,
        },
      }),
    );
    return ok(
      viewOf({
        ...row,
        status: 'rejected',
        decidedBy: admin,
        decidedAt: now,
        decisionReason: reason,
      }),
    );
  });
}

export interface AdminCreditExpiryReport {
  readonly expired: number;
  /** Ids whose unit failed; they are tried again on the next run. */
  readonly failed: readonly string[];
}

export const ADMIN_CREDIT_EXPIRY_BATCH = 100;

/** The worker's sweep: pending requests past their expiry become `expired`, one unit each. */
export async function expireAdminCredits(
  deps: AdminCreditDependencies,
  context: CallContext,
): Promise<Result<AdminCreditExpiryReport, AdminCreditFailure>> {
  if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
  const now = deps.clock.now();
  const due = await deps.unitOfWork.run<readonly Id<'WalletCreditRequest'>[], AdminCreditFailure>(
    context.market,
    async () => ok(await deps.credits.duePending(context.market, now, ADMIN_CREDIT_EXPIRY_BATCH)),
    { readOnly: true },
  );
  if (!due.ok) return due;
  let expired = 0;
  const failed: string[] = [];
  for (const id of due.value) {
    try {
      const done = await deps.unitOfWork.run<boolean, AdminCreditFailure>(
        context.market,
        async () => {
          const row = await deps.credits.findForUpdate(context.market, id);
          if (row === null || row.status !== 'pending' || !isPastExpiry(row.expiresAt, now)) {
            return ok(false);
          }
          await deps.credits.decide(context.market, id, {
            status: 'expired',
            decidedBy: null,
            decidedAt: now,
            decisionReason: null,
            journalId: null,
          });
          await deps.audit.record(
            context,
            AdminCreditExpired.entry(id, {
              before: { status: 'pending' },
              after: { status: 'expired', requestedBy: row.requestedBy },
            }),
          );
          return ok(true);
        },
      );
      if (done.ok && done.value) expired += 1;
    } catch {
      failed.push(id);
    }
  }
  return ok({ expired, failed });
}

// ---- reads --------------------------------------------------------------------------------------

export const CREDIT_PAGE_SIZE = 20;
export const MAX_CREDIT_PAGE_SIZE = 100;

/** Which requests a list shows: waiting for a decision, decided, or granted at once. */
export const CREDIT_LIST_FILTERS = ['pending', 'decided', 'granted'] as const;
export type CreditListFilter = (typeof CREDIT_LIST_FILTERS)[number];

const FILTER_STATUSES: Readonly<Record<CreditListFilter, readonly AdminCreditStatus[]>> = {
  pending: ['pending'],
  decided: ['approved', 'rejected', 'expired'],
  granted: ['granted'],
};

export interface CreditListView {
  readonly entries: readonly AdminCreditView[];
  readonly nextCursor: string | null;
}

const encodeCursor = (at: Temporal.Instant, id: string): string => `${at.epochMilliseconds}.${id}`;

function decodeCursor(value: unknown) {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'WalletCreditRequest'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return { requestedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

/** `ListAdminCreditRequests`: newest first, by filter (default pending). */
export async function listAdminCredits(
  deps: AdminCreditDependencies,
  context: CallContext,
  input: { readonly status?: unknown; readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<CreditListView, AdminCreditFailure>> {
  if (signedInAdmin(context) === null) return err({ code: 'access.denied' });
  const problems: Problem[] = [];
  const filter = input?.status ?? 'pending';
  if (!(CREDIT_LIST_FILTERS as readonly unknown[]).includes(filter)) {
    problems.push({ path: 'status', code: 'value' });
  }
  let limit = CREDIT_PAGE_SIZE;
  if (input?.limit !== undefined) {
    const value = input.limit;
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAX_CREDIT_PAGE_SIZE
    ) {
      limit = value;
    } else problems.push({ path: 'limit', code: 'range' });
  }
  const after = input?.cursor === undefined ? null : decodeCursor(input.cursor);
  if (after === undefined) problems.push({ path: 'cursor', code: 'format' });
  if (problems.length > 0 || after === undefined) return err(invalid(problems));
  const statuses = FILTER_STATUSES[filter as CreditListFilter];
  return deps.unitOfWork.run<CreditListView, AdminCreditFailure>(
    context.market,
    async () => {
      const rows = await deps.credits.list(context.market, { statuses, limit: limit + 1, after });
      const entries = rows.slice(0, limit);
      const last = entries[entries.length - 1];
      return ok({
        entries: entries.map(viewOf),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(last.requestedAt, last.id)
            : null,
      });
    },
    { readOnly: true },
  );
}

export interface CustomerWalletSummary {
  readonly customerAccountId: Id<'Account'>;
  readonly currency: string;
  readonly marketStatus: WalletStatus;
  /** `none` while the customer was never granted credit. */
  readonly accountStatus: 'active' | 'frozen' | 'closed' | 'none';
  readonly available: bigint;
  readonly held: bigint;
  readonly balanceCap: bigint;
  /** What may still be granted before the balance cap: cap minus available and held, at least 0. */
  readonly roomUnderCap: bigint;
  readonly issueCap: bigint;
  readonly dailyCap: bigint;
  /** What the calling admin has counted today toward the daily cap. */
  readonly usedToday: bigint;
}

/** `ViewCustomerWallet`: a customer's balance and the caller's caps, for the issuing screen. */
export async function viewCustomerWallet(
  deps: AdminCreditDependencies,
  context: CallContext,
  input: { readonly customerAccountId: unknown },
): Promise<Result<CustomerWalletSummary, AdminCreditFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const customer = idOf<'Account'>(input?.customerAccountId);
  if (customer === null) return err(invalid([{ path: 'customerAccountId', code: 'format' }]));
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const unknownCustomer = await customerCheck(deps, context, customer);
  if (unknownCustomer !== null) return err(unknownCustomer);
  const now = deps.clock.now();
  return deps.unitOfWork.run<CustomerWalletSummary, AdminCreditFailure>(
    context.market,
    async () => {
      const setting = await deps.settings.find(context.market);
      const marketStatus = setting?.status ?? 'off';
      if (refusalFor(marketStatus, 'read') !== null) return err({ code: 'wallet.disabled' });
      const wallet = await deps.wallet.findWallet(context.market, customer);
      const balance =
        wallet === null
          ? { availableMinor: 0n, heldMinor: 0n }
          : await deps.wallet.readBalance(context.market, wallet.id);
      const usedToday = await deps.credits.countedOnDay(
        context.market,
        admin,
        localDayOf(now, policy.timeZone),
      );
      const room = policy.balanceCapMinor - balance.availableMinor - balance.heldMinor;
      return ok({
        customerAccountId: customer,
        currency: policy.currency,
        marketStatus,
        accountStatus: wallet?.status ?? 'none',
        available: balance.availableMinor,
        held: balance.heldMinor,
        balanceCap: policy.balanceCapMinor,
        roomUnderCap: room > 0n ? room : 0n,
        issueCap: policy.adminIssueCapMinor,
        dailyCap: policy.adminDailyCapMinor,
        usedToday,
      });
    },
    { readOnly: true },
  );
}
