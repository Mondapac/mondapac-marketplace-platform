import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_SELLER_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { archivePost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.seller-archive-post`: Archives the seller's own post ("delete"). */
export class ArchiveOwnBlogPost extends UseCase<
  FlowInput<typeof archivePost>,
  FlowValue<typeof archivePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.seller-archive-post',
    rule: { kind: 'permissions', allOf: [BLOG_SELLER_POST_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof archivePost>) {
    return archivePost(this.deps, context, input, 'seller');
  }
}
