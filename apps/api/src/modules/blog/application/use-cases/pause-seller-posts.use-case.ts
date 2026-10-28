import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { pauseSellerPosts } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.pause-seller-posts`: Pauses a seller's live posts when an admin turned its blog access off and asked for it. */
export class PauseSellerBlogPosts extends UseCase<
  FlowInput<typeof pauseSellerPosts>,
  FlowValue<typeof pauseSellerPosts>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.pause-seller-posts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof pauseSellerPosts>) {
    return pauseSellerPosts(this.deps, context, input);
  }
}
