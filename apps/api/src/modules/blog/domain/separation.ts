// Separation of duties: the person who approves a version is not the person who wrote it nor the
// person who sent it for review. A reviewer who edits the text becomes its editor, so the approver
// differs from author, submitter and editor. One exception, set per Market in config: a Market
// with a single admin may allow an approval by the author or submitter after a fresh step-up, and
// that approval is recorded as a self-approval.

export type ApprovalDecision =
  | { readonly kind: 'allowed'; readonly selfApproved: false }
  /** Allowed only after a fresh step-up; the use case consumes it and records a self-approval. */
  | { readonly kind: 'step-up'; readonly selfApproved: true }
  | { readonly kind: 'denied' };

export interface ApprovalParties {
  readonly approver: string;
  /** The account that saved the version (an author, or the reviewer who edited it). */
  readonly createdBy: string;
  /** The account that sent the post for review. */
  readonly submittedBy: string | null;
}

export function approvalDecision(
  parties: ApprovalParties,
  selfApprovalWithStepUp: boolean,
): ApprovalDecision {
  const involved =
    parties.approver === parties.createdBy || parties.approver === parties.submittedBy;
  if (!involved) return { kind: 'allowed', selfApproved: false };
  return selfApprovalWithStepUp ? { kind: 'step-up', selfApproved: true } : { kind: 'denied' };
}
