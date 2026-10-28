import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_REVIEW } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { reviewerEdit } from '../edit-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.reviewer-edit`: A reviewer edits the text of a version in review; the edit is a new version flagged as the reviewer's. */
export class EditBlogPostInReview extends UseCase<
  FlowInput<typeof reviewerEdit>,
  FlowValue<typeof reviewerEdit>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.reviewer-edit',
    rule: { kind: 'permissions', allOf: [BLOG_POST_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof reviewerEdit>) {
    return reviewerEdit(this.deps, context, input);
  }
}
