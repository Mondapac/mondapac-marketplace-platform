import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { viewPublishedPost } from '../public-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.view-published-post`: One live post by address; an old address answers its new one; 410 once taken off, 404 otherwise. */
export class ViewPublishedBlogPost extends UseCase<
  FlowInput<typeof viewPublishedPost>,
  FlowValue<typeof viewPublishedPost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.view-published-post',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof viewPublishedPost>) {
    return viewPublishedPost(this.deps, context, input);
  }
}
