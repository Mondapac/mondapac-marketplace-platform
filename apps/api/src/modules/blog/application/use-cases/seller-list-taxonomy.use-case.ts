import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_SELLER_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { listTaxonomy } from '../taxonomy-flow';
import type { FlowValue } from '../flow-types';

/** `blog.seller-list-taxonomy`: The categories and tags a seller picks from. */
export class ListBlogTaxonomyForSeller extends UseCase<
  unknown,
  FlowValue<typeof listTaxonomy>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.seller-list-taxonomy',
    rule: { kind: 'permissions', allOf: [BLOG_SELLER_POST_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listTaxonomy(this.deps, context);
  }
}
