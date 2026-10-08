// The closed lists a business file revision and the file's events share (sellers design 3.1, 7.4;
// data design 3.2). Kept apart from both so the file aggregate and the revision need not import
// each other.

/** Why the revision exists (data design 3.2 `kind`). */
export const REVISION_KINDS = ['onboarding', 'identity-change'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const REVISION_AUTHOR_KINDS = ['seller', 'admin'] as const;
export type RevisionAuthorKind = (typeof REVISION_AUTHOR_KINDS)[number];

/** Why a pending revision was withdrawn (design 7.4); the caller is `seller` or `admin`. */
export const WITHDRAW_CAUSES = ['edited', 'cancelled', 'reapply-refused'] as const;
export type WithdrawCause = (typeof WITHDRAW_CAUSES)[number];
