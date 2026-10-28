import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { listTaxonomy } from '../taxonomy-flow';
import type { FlowValue } from '../flow-types';

/** `blog.list-taxonomy`: The categories and tags of the Market. */
export class ListBlogTaxonomy extends UseCase<
  unknown,
  FlowValue<typeof listTaxonomy>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.list-taxonomy',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
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
