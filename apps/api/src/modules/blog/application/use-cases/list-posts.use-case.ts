import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import {
  listAdminPosts,
  type AdminPostListDependencies,
  type AdminPostListFailure,
  type AdminPostListPage,
} from '../admin-post-list-flow';

export type { AdminPostListPage };

/**
 * `blog.list-posts`: the posts of the Market (the Blog posts super list, list 26): views by
 * status with counts, filters, search, sort, page numbers or Previous/Next, and each row's
 * actions. Ids, titles, slugs, states and times only.
 */
export class ListBlogPosts extends UseCase<
  { readonly query?: unknown },
  AdminPostListPage,
  AdminPostListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.list-posts',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminPostListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly query?: unknown }) {
    return listAdminPosts(this.deps, context, input);
  }
}
