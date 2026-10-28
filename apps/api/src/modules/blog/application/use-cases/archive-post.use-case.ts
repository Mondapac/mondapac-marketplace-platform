import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { archivePost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.archive-post`: Archives a platform post; it leaves the site. */
export class ArchiveBlogPost extends UseCase<
  FlowInput<typeof archivePost>,
  FlowValue<typeof archivePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.archive-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof archivePost>) {
    return archivePost(this.deps, context, input, 'admin');
  }
}
