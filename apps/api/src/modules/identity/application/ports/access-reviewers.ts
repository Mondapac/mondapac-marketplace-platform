import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * An admin account that may receive the reviewer notice (identity design 8.7): its id and the
 * address the mail goes to. The address stays in memory: it is never logged, returned or put in
 * an event.
 */
export interface AccessReviewer {
  readonly accountId: Id<'Account'>;
  readonly email: string;
}

/**
 * The SQL half of the recipient read (identity design 8.7; Hassan M2): it only narrows the
 * candidates. Runs in the caller's open read-only unit and takes the `MarketContext` only.
 */
export interface ReviewerCandidateReader {
  /**
   * Up to `limit` accounts of the `admin` population in this Market that are `active` and whose
   * email is verified, by account id. Whether one may review is decided in code
   * (`effectiveKeysOf`, the active second factor), never here.
   */
  activeVerifiedAdmins(market: MarketContext, limit: number): Promise<AccessReviewer[]>;
}

/** Nest token of the {@link ReviewerCandidateReader}. */
export const REVIEWER_CANDIDATE_READER = Symbol('REVIEWER_CANDIDATE_READER');

/** The recipient read could not be done; the notice is `reviewer-notice.unavailable`. */
export class AccessReviewersUnavailableError extends Error {
  override readonly name = 'AccessReviewersUnavailableError';
  constructor() {
    super('identity: the reviewer read failed');
  }
}

/**
 * Who may act on a seller application in a Market (identity design 8.7): the admins who hold
 * `identity.seller-access.approve`, by account id. Throws
 * {@link AccessReviewersUnavailableError} when the read fails, never answers a guess.
 */
export interface AccessReviewers {
  reviewersOf(market: MarketContext): Promise<readonly AccessReviewer[]>;
}

/** Nest token of the {@link AccessReviewers}. */
export const ACCESS_REVIEWERS = Symbol('ACCESS_REVIEWERS');
