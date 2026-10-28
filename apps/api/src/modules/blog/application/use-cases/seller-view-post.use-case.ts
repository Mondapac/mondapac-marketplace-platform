import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_SELLER_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { viewPostForSeller } from '../read-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.seller-view-post`: One of the seller's own posts. */
export class ViewOwnBlogPost extends UseCase<
  FlowInput<typeof viewPostForSeller>,
  FlowValue<typeof viewPostForSeller>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.seller-view-post',
    rule: { kind: 'permissions', allOf: [BLOG_SELLER_POST_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof viewPostForSeller>) {
    return viewPostForSeller(this.deps, context, input);
  }
}
