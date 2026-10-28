import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { publishPost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.publish-post`: Makes the approved version live now. */
export class PublishBlogPost extends UseCase<
  FlowInput<typeof publishPost>,
  FlowValue<typeof publishPost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.publish-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof publishPost>) {
    return publishPost(this.deps, context, input);
  }
}
