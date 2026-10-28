import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { listPublished } from '../public-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.view-published-posts`: The live posts of the Market, newest first, by kind, category or tag; paged. */
export class ListPublishedBlogPosts extends UseCase<
  FlowInput<typeof listPublished>,
  FlowValue<typeof listPublished>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.view-published-posts',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof listPublished>) {
    return listPublished(this.deps, context, input);
  }
}
