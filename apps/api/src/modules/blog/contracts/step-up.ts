import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions blog owns (issue #491). `blog.post.self-approve`: in a Market that allows a
 * single admin to approve a post they wrote or sent for review (Market config
 * `blog.selfApprovalWithStepUp`), the admin presents a fresh two-step code
 * (`POST identity/admin/step-up/verify`) before approving; the code is spent in `approvePost`, in
 * the unit of the approval, because only that call knows whether the approver is the writer.
 */
export const BLOG_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'blog.post.self-approve', defaultRequired: true, locked: true, audience: 'admin' },
];

export const BLOG_SELF_APPROVE_STEP_UP = 'blog.post.self-approve';
