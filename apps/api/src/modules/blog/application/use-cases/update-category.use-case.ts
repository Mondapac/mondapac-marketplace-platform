import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_TAXONOMY_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { updateCategory } from '../taxonomy-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.update-category`: Changes the names and position of a category (its address never changes). */
export class UpdateBlogCategory extends UseCase<
  FlowInput<typeof updateCategory>,
  FlowValue<typeof updateCategory>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.update-category',
    rule: { kind: 'permissions', allOf: [BLOG_TAXONOMY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof updateCategory>) {
    return updateCategory(this.deps, context, input);
  }
}
