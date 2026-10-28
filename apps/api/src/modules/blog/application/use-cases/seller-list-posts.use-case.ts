import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_SELLER_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { listPostsForSeller } from '../read-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.seller-list-posts`: The seller's own posts, while its blog switch is on. */
export class ListOwnBlogPosts extends UseCase<
  FlowInput<typeof listPostsForSeller>,
  FlowValue<typeof listPostsForSeller>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.seller-list-posts',
    rule: { kind: 'permissions', allOf: [BLOG_SELLER_POST_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof listPostsForSeller>) {
    return listPostsForSeller(this.deps, context, input);
  }
}
