import { ok } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  AccessReviewersUnavailableError,
  type AccessReviewer,
  type AccessReviewers,
  type ReviewerCandidateReader,
} from '../ports/access-reviewers';
import { effectiveKeysOf, holdsEvery } from './effective-keys';

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

/**
 * The accounts with an active second factor. There is no factor store before slice 7, so no
 * admin has one: fail closed. Slice 7, which first creates admin accounts, replaces this with the
 * factor read in the same slice (identity design 12.1).
 */
const WITH_ACTIVE_SECOND_FACTOR: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Whether an account the SQL read admitted may receive the reviewer notice: an active second
 * factor and `identity.seller-access.approve` among its effective keys, by the same
 * `effectiveKeysOf` the gate decides `permissions` rules with (Hassan M2, Ali C5).
 */
export function isAccessReviewer(candidate: AccessReviewer): boolean {
  return (
    WITH_ACTIVE_SECOND_FACTOR.has(candidate.accountId) &&
    holdsEvery(effectiveKeysOf({ population: 'admin', accountId: candidate.accountId }), [
      SELLER_ACCESS_APPROVE,
    ])
  );
}

export interface AccountAccessReviewersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly candidates: ReviewerCandidateReader;
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
    return read.value
      .filter(isAccessReviewer)
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }
}
