import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_TAXONOMY_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { createCategory } from '../taxonomy-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.create-category`: Creates a category with a name per locale. */
export class CreateBlogCategory extends UseCase<
  FlowInput<typeof createCategory>,
  FlowValue<typeof createCategory>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.create-category',
    rule: { kind: 'permissions', allOf: [BLOG_TAXONOMY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof createCategory>) {
    return createCategory(this.deps, context, input);
  }
}
