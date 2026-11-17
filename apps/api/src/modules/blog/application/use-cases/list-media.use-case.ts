import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { listMedia } from '../media-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.list-media`: The pictures of the media library of the Market, newest first, paged. */
export class ListBlogMedia extends UseCase<
  FlowInput<typeof listMedia>,
  FlowValue<typeof listMedia>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.list-media',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof listMedia>) {
    return listMedia(this.deps, context, input);
  }
}
