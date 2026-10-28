import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_SELLER_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { createPost } from '../edit-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.seller-create-post`: A seller's own post with its first draft. */
export class CreateOwnBlogPost extends UseCase<
  FlowInput<typeof createPost>,
  FlowValue<typeof createPost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.seller-create-post',
    rule: { kind: 'permissions', allOf: [BLOG_SELLER_POST_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof createPost>) {
    return createPost(this.deps, context, input, 'seller');
  }
}
