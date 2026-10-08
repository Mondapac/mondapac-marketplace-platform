import { ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCESS_APPROVE as APPROVE } from '../../contracts/permissions';
import {
  AccessReviewersUnavailableError,
  type AccessReviewer,
  type AccessReviewers,
  type ReviewerCandidateReader,
} from '../ports/access-reviewers';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { holdsEvery, type EffectiveKeyResolver, type RoleGrant } from './effective-keys';

/**
 * The key a reviewer holds (identity design 8.7; `ux.md` E3 "Admins who may approve"): the
 * declaration of identity's catalogue (5.3; slice 8a-1).
 */
export const SELLER_ACCESS_APPROVE: string = APPROVE.key;

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
  /**
   * The shared resolver: the one bound to `EFFECTIVE_KEY_RESOLVER`, the gate's definition too
   * (Hassan M2; R-3 review N-1).
   */
  readonly keys: EffectiveKeyResolver;
}

/**
 * Whether an account the SQL read admitted may receive the reviewer notice: an active second
 * factor and `identity.seller-access.approve` among its effective keys, by the same resolver the
 * gate decides `permissions` rules with (Hassan M2, Ali C5). `grant` is the candidate's role,
 * read in the same unit as the candidates.
 */
export function isAccessReviewer(
  candidate: AccessReviewer,
  grant: RoleGrant | null,
  rule: ReviewerRule,
): boolean {
  return (
    rule.factors.hasActiveFactor(candidate.accountId) &&
    holdsEvery(
      rule.keys({ population: 'admin', accountId: candidate.accountId, sellerId: null, grant }),
      [SELLER_ACCESS_APPROVE],
    )
  );
}

export interface AccountAccessReviewersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly candidates: ReviewerCandidateReader;
  /** The candidates' roles (slice 8a-1), read in the same read-only unit. */
  readonly grants: RoleGrantReader;
  /** The shared key resolver (N-1). */
  readonly effectiveKeys: EffectiveKeyResolver;
  /** {@link NO_SECOND_FACTOR_STORE} until slice 7 binds the factor store. */
  readonly factors?: ActiveSecondFactors;
}

/**
 * {@link AccessReviewers} over identity's own accounts (identity design 8.7). One read-only unit
 * (ADR-0025: no transaction) narrows by Market, population `admin`, `active` and a verified
 * email, and reads the candidates' roles; who may review is then evaluated in code. Since slice
 * 8a-1 the grant read and the registry are bound; until slice 7 binds the factor store no admin
 * has an active factor, so the answer is still an explicit empty set (`recipients.none`).
 */
export class AccountAccessReviewers implements AccessReviewers {
  constructor(private readonly deps: AccountAccessReviewersDependencies) {}

  async reviewersOf(market: MarketContext): Promise<readonly AccessReviewer[]> {
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const candidates = await this.deps.candidates.activeVerifiedAdmins(
          market,
          MAX_REVIEWER_CANDIDATES,
        );
        const grants =
          candidates.length === 0
            ? new Map<Id<'Account'>, RoleGrant>()
            : await this.deps.grants.grantsOf(
                market,
                candidates.map((c) => c.accountId),
              );
        return ok({ candidates, grants });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new AccessReviewersUnavailableError();
    const rule: ReviewerRule = {
      factors: this.deps.factors ?? NO_SECOND_FACTOR_STORE,
      keys: this.deps.effectiveKeys,
    };
    const { candidates, grants } = read.value;
    return candidates
      .filter((candidate) =>
        isAccessReviewer(candidate, grants.get(candidate.accountId) ?? null, rule),
      )
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }
}
