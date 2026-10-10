import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { DecisionIntentKind } from '../../domain/decision-intent';
import { registerGuard, type RegisterGuardRefused } from '../../domain/review-check';
import type { AccessUnavailable, SellersUnavailable } from '../draft/draft-support';
import type { FileNotFound } from '../draft/draft-view';
import type { RegisterCheckRepository } from '../ports/register-check.repository';
import type { RegisterLookupPolicy } from '../ports/register-lookup-policy';
import type { ReviewCheckRepository } from '../ports/review-check.repository';
import type { AccessDecisionAnswer, SellerAccessDecider } from '../ports/seller-access-decider';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import {
  releaseDecision,
  settleDecision,
  type SettlementDependencies,
} from './decision-settlement';

// A reviewer's approve or reject of an onboarding revision (sellers design 3.1, 3.2, 6.2, 7.3;
// slice 7a-decide): two read-write units around one call into `identity`, made outside any unit
// (PP 3.1 row 5; ADR-0022 decision 4).

/** The request: the seller from the path, revision N from the body (AC 10), the reason for a reject. */
export interface ReviewDecisionInput {
  readonly sellerId?: unknown;
  readonly revisionId?: unknown;
  /** Reject only. Personal data for the seller: passed to `identity`, never kept or logged here. */
  readonly reason?: unknown;
}

/**
 * The answer: the decision recorded, or `in-progress` when `identity` did not answer in time (or
 * the answer could not be settled at once). Then the intent stays and the handler of
 * `identity`'s event or the reconciliation job settles it; the page reads the review again.
 */
export interface ReviewDecided {
  readonly decision: 'approved' | 'rejected' | 'in-progress';
  readonly revisionId: Id<'BusinessFileRevision'>;
}

/** Codes of `identity`'s refusal that pass through to the reviewer unchanged (identity design 8.6). */
const IDENTITY_REFUSALS = [
  'seller-access.wrong-state',
  'seller-access.owner-unverified',
  'seller-access.reason-required',
  'access.denied',
] as const;
type IdentityRefusal = (typeof IDENTITY_REFUSALS)[number];

export type ReviewDecisionFailure =
  | FileNotFound
  | AccessUnavailable
  | SellersUnavailable
  /** The request does not name the pending onboarding revision (AC 10, AC 22). */
  | { readonly code: 'review.not-current-revision' }
  /** Another decision on this file is in flight. */
  | { readonly code: 'file.decision-in-progress' }
  /** Another seller of the Market holds the identifier (AC 21). Never told to the seller. */
  | { readonly code: 'review.identifier-claimed' }
  | RegisterGuardRefused
  | { readonly code: IdentityRefusal }
  /** The reason's length or characters (identity's HF13), or a missing or malformed field. */
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'conflict.stale' };

export interface ReviewDecisionDependencies extends SettlementDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accessReader: SellerAccessReader;
  readonly decider: SellerAccessDecider;
  readonly registerChecks: RegisterCheckRepository;
  readonly registerPolicy: RegisterLookupPolicy;
  readonly reviewChecks: ReviewCheckRepository;
}

/** The largest reason passed on; `identity` applies its own rule (HF13) within it. */
export const MAX_REASON_LENGTH = 2000;

const logger = new Logger('SellersReviewDecision');

/** Parses the path and body ids; a malformed seller id is `file.not-found` (AC 1). */
function parsed(
  input: ReviewDecisionInput,
  kind: 'approve' | 'reject',
): Result<
  { sellerId: Id<'Seller'>; revisionId: Id<'BusinessFileRevision'>; reason: string },
  | FileNotFound
  | Extract<ReviewDecisionFailure, { code: 'validation.failed' }>
  | { readonly code: 'seller-access.reason-required' }
> {
  const seller = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
  if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
  const fields: { path: string; code: string }[] = [];
  const revision =
    typeof input.revisionId === 'string' ? parseId<'BusinessFileRevision'>(input.revisionId) : null;
  if (revision === null || !revision.ok) fields.push({ path: 'revisionId', code: 'format' });
  let reason = '';
  if (kind === 'reject') {
    if (typeof input.reason !== 'string') fields.push({ path: 'reason', code: 'type' });
    else if (input.reason.trim() === '') return err({ code: 'seller-access.reason-required' });
    else if ([...input.reason].length > MAX_REASON_LENGTH) {
      fields.push({ path: 'reason', code: 'length' });
    } else reason = input.reason;
  }
  if (fields.length > 0 || revision === null || !revision.ok) {
    return err({ code: 'validation.failed', fields });
  }
  return ok({ sellerId: seller.value, revisionId: revision.value, reason });
}

/**
 * The whole decision of design 7.3 for one seller:
 *
 * 1. `identity`'s state is read live: an unknown seller is `file.not-found`; only `pending` may
 *    be decided (`seller-access.wrong-state`), so no claim is taken for nothing;
 * 2. unit 1 locks the file (its version compare-and-set) and sets the intent, then checks, under
 *    that lock: revision N is the pending onboarding revision (`review.not-current-revision`), no
 *    other decision is in flight, and for an approval the register guard of revision N (3.4,
 *    `registerGuard`) and the identifier claim (AC 21). Any refusal rolls the unit back;
 * 3. `identity` decides, outside any unit, under the reviewer's own context (double gate) and
 *    with `basisId` = N, within 30 seconds;
 * 4. unit 2 settles: the decision is recorded (`settleDecision`), or after a refusal the claim and
 *    the intent are released (`releaseDecision`) and `identity`'s code is answered. No answer in
 *    time: the intent stays for the event handler or the job, and the answer is `in-progress`.
 *
 * Nothing but ids and codes is logged; the reason never is.
 */
export async function decideOnRevision(
  deps: ReviewDecisionDependencies,
  context: CallContext,
  input: ReviewDecisionInput,
  kind: 'approve' | 'reject',
): Promise<Result<ReviewDecided, ReviewDecisionFailure>> {
  const request = parsed(input ?? {}, kind);
  if (!request.ok) return request;
  const { sellerId, revisionId, reason } = request.value;
  const { market } = context;

  let access;
  try {
    access = await deps.accessReader.accessOf(context, sellerId);
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
  if (access === null) return err({ code: 'file.not-found' });
  if (access !== 'pending') return err({ code: 'seller-access.wrong-state' });

  const attemptId = deps.ids.next<'DecisionAttempt'>();
  const intentKind: DecisionIntentKind =
    kind === 'approve' ? 'approve-requested' : 'reject-requested';
  let begun;
  try {
    begun = await deps.unitOfWork.run<void, ReviewDecisionFailure>(market, () =>
      beginDecision(deps, context, sellerId, revisionId, intentKind, attemptId),
    );
  } catch (error) {
    return unavailable(context, 'begin-failed', error);
  }
  if (!begun.ok) return begun;

  let answer: AccessDecisionAnswer | null;
  try {
    answer =
      kind === 'approve'
        ? await deps.decider.approve(context, sellerId, revisionId)
        : await deps.decider.reject(context, sellerId, reason, revisionId);
  } catch (error) {
    // identity may or may not have decided: the intent stays for the handler or the job.
    logger.warn({
      msg: 'sellers.review-decision-unconfirmed',
      error: error instanceof Error ? error.name : 'unknown',
      sellerId,
      revisionId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    answer = null;
  }
  if (answer === null) return ok({ decision: 'in-progress', revisionId });

  if (answer.kind === 'decided') {
    const outcome = kind === 'approve' ? 'approved' : 'rejected';
    try {
      const settled = await deps.unitOfWork.run(market, () =>
        settleDecision(deps, context, sellerId, revisionId, {
          outcome,
          decisionId: answer.decisionId,
        }),
      );
      // A lost race means another path settled (or is settling) the same decision.
      return ok({ decision: settled.ok ? outcome : 'in-progress', revisionId });
    } catch (error) {
      // identity has decided: the event handler or the job records it, so the answer is
      // in-progress, never a failure the reviewer would retry (Sajad).
      logger.error({
        msg: 'sellers.review-decision.settle-deferred',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId,
        revisionId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return ok({ decision: 'in-progress', revisionId });
    }
  }
  try {
    const released = await deps.unitOfWork.run(market, () =>
      releaseDecision(deps, context, sellerId, revisionId, attemptId),
    );
    if (!released.ok) {
      logger.warn({
        msg: 'sellers.review-decision-release-deferred',
        sellerId,
        revisionId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
  } catch (error) {
    return unavailable(context, 'settle-failed', error);
  }
  return err(refusalOf(answer.code, answer.rule));
}

/** Unit 1 of 7.3: lock the file, check under the lock, take the claim, set the intent. */
async function beginDecision(
  deps: ReviewDecisionDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  revisionId: Id<'BusinessFileRevision'>,
  intentKind: DecisionIntentKind,
  attemptId: Id<'DecisionAttempt'>,
): Promise<Result<void, ReviewDecisionFailure>> {
  const { market } = context;
  const { files, revisions, clock } = deps;
  const file = await files.findById(market, sellerId);
  if (file === null) return err({ code: 'file.not-found' });
  const now = clock.now();
  const begun = file.beginDecision({ kind: intentKind, attemptId, revisionId, since: now });
  if (!begun.ok) {
    return begun.error.code === 'file.decision-in-progress'
      ? err(begun.error)
      : err({ code: 'review.not-current-revision' });
  }
  // The row lock: from here no draft save, withdrawal or other decision of this file runs until
  // this unit ends, and what is read below is what the intent locks.
  if (!(await files.recordDecision(market, file, null))) return err({ code: 'conflict.stale' });

  const revision = await revisions.findById(market, sellerId, revisionId);
  if (revision === null || revision.status !== 'pending' || revision.kind !== 'onboarding') {
    return err({ code: 'review.not-current-revision' });
  }
  if (intentKind !== 'approve-requested') return ok(undefined);

  const settings = deps.registerPolicy.settingsOf(market);
  const index = revision.identifierIndex;
  const check =
    settings.kind === 'configured' && index !== null
      ? await deps.registerChecks.find(market, sellerId, index)
      : null;
  const manual = await deps.reviewChecks.findManualRegisterCheck(market, sellerId, revisionId);
  const guarded = registerGuard({
    hasIdentifier: index !== null,
    lookupMaxResultAgeDays: settings.kind === 'configured' ? settings.maxResultAgeDays : null,
    snapshot: revision.register,
    submittedAt: revision.createdAt,
    check,
    manual,
    now,
  });
  if (!guarded.ok) return guarded;

  if (index !== null) {
    const claim = await deps.claims.take(market, { sellerId, revisionId, index, now });
    // Another seller holds the value (AC 21), or this seller still holds a claim on another value:
    // either way a person looks first.
    if (claim === 'held-by-other' || claim === 'seller-holds-another') {
      return err({ code: 'review.identifier-claimed' });
    }
  }
  return ok(undefined);
}

function refusalOf(code: string, rule: string | undefined): ReviewDecisionFailure {
  if ((IDENTITY_REFUSALS as readonly string[]).includes(code)) {
    return { code: code as IdentityRefusal };
  }
  if (code === 'seller.unknown') return { code: 'file.not-found' };
  if (code === 'validation.failed') {
    return { code: 'validation.failed', fields: [{ path: 'reason', code: rule ?? 'rejected' }] };
  }
  return { code: 'access.unavailable' };
}

function unavailable(context: CallContext, step: string, error: unknown) {
  logger.error({
    msg: `sellers.review-decision.${step}`,
    error: error instanceof Error ? error.name : 'unknown',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return err({ code: 'sellers.unavailable' } as const);
}

/** The outcome line of a decision request: ids and codes only, never the reason. */
export function logDecision(
  logger: Logger,
  name: string,
  context: CallContext,
  result: Result<ReviewDecided, ReviewDecisionFailure>,
): void {
  logger.log({
    msg: name,
    code: result.ok ? result.value.decision : result.error.code,
    revisionId: result.ok ? result.value.revisionId : undefined,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}
