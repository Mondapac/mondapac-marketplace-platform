import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_SELLER_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { submitPost } from '../review-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.seller-submit-post`: Sends the seller's post for review; the first send of a post uses one unit of the month's quota. */
export class SubmitOwnBlogPost extends UseCase<
  FlowInput<typeof submitPost>,
  FlowValue<typeof submitPost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.seller-submit-post',
    rule: { kind: 'permissions', allOf: [BLOG_SELLER_POST_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof submitPost>) {
    return submitPost(this.deps, context, input, 'seller');
  }
}
