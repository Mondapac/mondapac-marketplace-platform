import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { listPostsForAdmin } from '../read-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.list-posts`: The posts of the Market, newest first, by status, kind, owner or seller. */
export class ListBlogPosts extends UseCase<
  FlowInput<typeof listPostsForAdmin>,
  FlowValue<typeof listPostsForAdmin>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.list-posts',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof listPostsForAdmin>) {
    return listPostsForAdmin(this.deps, context, input);
  }
}
