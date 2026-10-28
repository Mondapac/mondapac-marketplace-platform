import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_REVIEW } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { approvePost } from '../review-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.approve-post`: Approves the version in review; the approver is neither its writer nor its sender, unless the Market allows a self-approval after a step-up. */
export class ApproveBlogPost extends UseCase<
  FlowInput<typeof approvePost>,
  FlowValue<typeof approvePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.approve-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof approvePost>) {
    return approvePost(this.deps, context, input);
  }
}
