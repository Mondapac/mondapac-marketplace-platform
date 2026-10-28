import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_TAXONOMY_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { deleteCategory } from '../taxonomy-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.delete-category`: Deletes a category no version uses. */
export class DeleteBlogCategory extends UseCase<
  FlowInput<typeof deleteCategory>,
  FlowValue<typeof deleteCategory>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.delete-category',
    rule: { kind: 'permissions', allOf: [BLOG_TAXONOMY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof deleteCategory>) {
    return deleteCategory(this.deps, context, input);
  }
}
