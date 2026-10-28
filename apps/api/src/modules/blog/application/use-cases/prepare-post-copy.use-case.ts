import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { prepareCopy } from '../edit-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.prepare-post-copy`: The package that copies a platform post into another Market as a new draft. */
export class PrepareBlogPostCopy extends UseCase<
  FlowInput<typeof prepareCopy>,
  FlowValue<typeof prepareCopy>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.prepare-post-copy',
    rule: { kind: 'permissions', allOf: [BLOG_POST_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof prepareCopy>) {
    return prepareCopy(this.deps, context, input);
  }
}
