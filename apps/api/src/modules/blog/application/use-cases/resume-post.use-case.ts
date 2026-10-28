import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { resumePost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.resume-post`: Puts a paused post back on the site with the live version it had. */
export class ResumeBlogPost extends UseCase<
  FlowInput<typeof resumePost>,
  FlowValue<typeof resumePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.resume-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof resumePost>) {
    return resumePost(this.deps, context, input);
  }
}
