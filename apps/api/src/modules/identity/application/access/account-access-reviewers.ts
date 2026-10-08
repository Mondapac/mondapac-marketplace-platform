import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  AccessReviewersUnavailableError,
  type AccessReviewer,
  type AccessReviewers,
  type ReviewerCandidateReader,
} from '../ports/access-reviewers';
import {
  effectiveKeysOf,
  holdsEvery,
  type EffectiveKeyResolver,
  type EffectiveKeysSubject,
} from './effective-keys';

/**
 * The key a reviewer holds (identity design 8.7; `ux.md` E3 "Admins who may approve"). Slice
 * 8a-1 declares it with `definePermission` in identity's `contracts/`; this constant then names
 * that declaration.
 */
export const SELLER_ACCESS_APPROVE = 'identity.seller-access.approve';

/**
 * The most candidates one read loads. A Market holds 10² admin accounts or fewer (identity design
 * 8.7), so this bound is a guard against an unbounded read, not a page.
 */
export const MAX_REVIEWER_CANDIDATES = 1000;

/** Whether an account has an active second factor (identity design 3.6, 7; slice 7). */
export interface ActiveSecondFactors {
  hasActiveFactor(accountId: Id<'Account'>): boolean;
}

const NO_ACTIVE_FACTORS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * The factor lookup until slice 7: there is no factor store, so no admin has an active factor
 * and the reviewer rule fails closed. Slice 7, which first creates admin accounts, replaces it
 * with the factor read in the same slice (identity design 12.1).
 */
export const NO_SECOND_FACTOR_STORE: ActiveSecondFactors = Object.freeze({
  hasActiveFactor: (accountId: Id<'Account'>) => NO_ACTIVE_FACTORS.has(accountId),
});

/** The two lookups the reviewer rule needs, as ports (Sajad F1). */
export interface ReviewerRule {
  readonly factors: ActiveSecondFactors;
  /** The shared resolver: {@link effectiveKeysOf}, the gate's one definition (Hassan M2). */
  readonly keys: EffectiveKeyResolver;
}

/** Production: no factor store before slice 7; the shared key rule. */
export const DEFAULT_REVIEWER_RULE: ReviewerRule = Object.freeze({
  factors: NO_SECOND_FACTOR_STORE,
  keys: (subject: EffectiveKeysSubject) => effectiveKeysOf(subject),
});

/**
 * Whether an account the SQL read admitted may receive the reviewer notice: an active second
 * factor and `identity.seller-access.approve` among its effective keys, by the same resolver the
 * gate decides `permissions` rules with (Hassan M2, Ali C5).
 */
export function isAccessReviewer(
  candidate: AccessReviewer,
  rule: ReviewerRule = DEFAULT_REVIEWER_RULE,
): boolean {
  return (
    rule.factors.hasActiveFactor(candidate.accountId) &&
    holdsEvery(rule.keys({ population: 'admin', accountId: candidate.accountId }), [
      SELLER_ACCESS_APPROVE,
    ])
  );
}

export interface AccountAccessReviewersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly candidates: ReviewerCandidateReader;
  /** {@link DEFAULT_REVIEWER_RULE} when absent. */
  readonly rule?: ReviewerRule;
}

/**
 * {@link AccessReviewers} over identity's own accounts (identity design 8.7). One read-only unit
 * (ADR-0025: no transaction) narrows by Market, population `admin`, `active` and a verified
 * email; who may review is then evaluated in code. Until slices 7 and 8a-1 the answer is an
 * explicit empty set (no admin has a factor or a key): the notice is `recipients.none`.
 */
export class AccountAccessReviewers implements AccessReviewers {
  constructor(private readonly deps: AccountAccessReviewersDependencies) {}

  async reviewersOf(market: MarketContext): Promise<readonly AccessReviewer[]> {
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(await this.deps.candidates.activeVerifiedAdmins(market, MAX_REVIEWER_CANDIDATES)),
      { readOnly: true },
    );
    if (!read.ok) throw new AccessReviewersUnavailableError();
    const rule = this.deps.rule ?? DEFAULT_REVIEWER_RULE;
    return read.value
      .filter((candidate) => isAccessReviewer(candidate, rule))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }
}
