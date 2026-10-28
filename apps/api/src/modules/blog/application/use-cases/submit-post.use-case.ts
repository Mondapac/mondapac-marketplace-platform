import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { submitPost } from '../review-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.submit-post`: Sends the draft of a platform post for review, after the automatic checks pass. */
export class SubmitBlogPost extends UseCase<
  FlowInput<typeof submitPost>,
  FlowValue<typeof submitPost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.submit-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof submitPost>) {
    return submitPost(this.deps, context, input, 'admin');
  }
}
