import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PAUSE } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { pausePost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.pause-post`: Takes a published post off the site at once, with a reason; no approval. */
export class PauseBlogPost extends UseCase<
  FlowInput<typeof pausePost>,
  FlowValue<typeof pausePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.pause-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PAUSE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof pausePost>) {
    return pausePost(this.deps, context, input);
  }
}
