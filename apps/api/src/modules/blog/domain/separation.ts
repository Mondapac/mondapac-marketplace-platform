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
}

/**
 * The writers of a version: its own writer and, while it is a reviewer's edit, the writer of the
 * version it replaced, back to the first version that is not a reviewer's edit (the author's).
 */
export function writersOf(
  versions: readonly WrittenVersion[],
  versionNo: number,
): readonly string[] {
  const byNo = new Map(versions.map((version) => [version.versionNo, version]));
  const writers = new Set<string>();
  for (let no = versionNo; no >= 1; no -= 1) {
    const version = byNo.get(no);
    if (version === undefined) continue;
    writers.add(version.createdBy);
    if (!version.editedByReviewer) break;
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
