import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { createPost } from '../edit-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.create-post`: A platform post with its first draft (copied: true marks a copy from another Market). */
export class CreateBlogPost extends UseCase<
  FlowInput<typeof createPost>,
  FlowValue<typeof createPost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.create-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof createPost>) {
    return createPost(this.deps, context, input, 'admin');
  }
}
