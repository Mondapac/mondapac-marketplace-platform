import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_TAXONOMY_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { deleteTag } from '../taxonomy-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.delete-tag`: Deletes a tag no version uses. */
export class DeleteBlogTag extends UseCase<
  FlowInput<typeof deleteTag>,
  FlowValue<typeof deleteTag>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.delete-tag',
    rule: { kind: 'permissions', allOf: [BLOG_TAXONOMY_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof deleteTag>) {
    return deleteTag(this.deps, context, input);
  }
}
