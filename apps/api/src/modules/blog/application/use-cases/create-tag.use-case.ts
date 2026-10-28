import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_TAXONOMY_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { createTag } from '../taxonomy-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.create-tag`: Creates a tag. */
export class CreateBlogTag extends UseCase<
  FlowInput<typeof createTag>,
  FlowValue<typeof createTag>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.create-tag',
    rule: { kind: 'permissions', allOf: [BLOG_TAXONOMY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof createTag>) {
    return createTag(this.deps, context, input);
  }
}
