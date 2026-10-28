// Separation of duties: the person who approves a version is not a person who wrote it nor the
// person who sent it for review. A reviewer who edits the text becomes one of its writers, and the
// author of the version the reviewer edited stays one, so the approver differs from author,
// submitter and every editor. One exception, set per Market in config: a Market with a single admin
// may allow an approval by a writer or the submitter after a fresh step-up, and that approval is
// recorded as a self-approval.

export type ApprovalDecision =
  | { readonly kind: 'allowed'; readonly selfApproved: false }
  /** Allowed only after a fresh step-up; the use case consumes it and records a self-approval. */
  | { readonly kind: 'step-up'; readonly selfApproved: true }
  | { readonly kind: 'denied' };

export interface ApprovalParties {
  readonly approver: string;
  /** The accounts that wrote the version: its author and the reviewers who edited it (see {@link writersOf}). */
  readonly writers: readonly string[];
  /** The account that sent the post for review. */
  readonly submittedBy: string | null;
}

export interface WrittenVersion {
  readonly versionNo: number;
  readonly createdBy: string;
  readonly editedByReviewer: boolean;
  readonly state: string;
  readonly decision: string | null;
  readonly publishedAt: unknown;
}

/** A version that was replaced before anyone decided on it or published it (another writer's draft, or the version a reviewer edited). */
const superseded = (version: WrittenVersion): boolean =>
  version.state === 'retired' && version.decision === null && version.publishedAt === null;

/**
 * The writers of a version: everyone who wrote its text in the current round. It walks back from
 * the version to the one before while the current one is a reviewer's edit or the one before was
 * superseded (retired with no decision and never published), and stops at a version that carries a
 * decision or was live: that ends the previous round.
 */
export function writersOf(
  versions: readonly WrittenVersion[],
  versionNo: number,
): readonly string[] {
  const byNo = new Map(versions.map((version) => [version.versionNo, version]));
  const writers = new Set<string>();
  let current = byNo.get(versionNo);
  while (current !== undefined) {
    writers.add(current.createdBy);
    const previous = byNo.get(current.versionNo - 1);
    if (previous === undefined) break;
    if (previous.decision !== null || previous.publishedAt !== null) break;
    if (!current.editedByReviewer && !superseded(previous)) break;
    current = previous;
  }
  return [...writers];
}

export function approvalDecision(
  parties: ApprovalParties,
  selfApprovalWithStepUp: boolean,
): ApprovalDecision {
  const involved =
    parties.writers.includes(parties.approver) || parties.approver === parties.submittedBy;
  if (!involved) return { kind: 'allowed', selfApproved: false };
  return selfApprovalWithStepUp ? { kind: 'step-up', selfApproved: true } : { kind: 'denied' };
}
