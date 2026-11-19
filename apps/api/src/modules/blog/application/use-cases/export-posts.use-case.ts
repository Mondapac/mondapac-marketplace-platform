import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import {
  exportAdminPosts,
  type AdminPostListDependencies,
  type PostExportFailure,
} from '../admin-post-list-flow';

/**
 * `blog.export-posts`: the admin Blog posts list as a CSV or XLSX file, the chosen posts or what
 * the list's view and filters match (at most 10,000). Same key as the list.
 */
export class ExportBlogPosts extends UseCase<
  { readonly query?: unknown },
  ExportFile,
  PostExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.export-posts',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminPostListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly query?: unknown }) {
    return exportAdminPosts(this.deps, context, input);
  }
}
