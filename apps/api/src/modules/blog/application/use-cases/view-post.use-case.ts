import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_READ } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { viewPostForAdmin } from '../read-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.view-post`: One post with its working version, its live version and the version list. */
export class ViewBlogPost extends UseCase<
  FlowInput<typeof viewPostForAdmin>,
  FlowValue<typeof viewPostForAdmin>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.view-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof viewPostForAdmin>) {
    return viewPostForAdmin(this.deps, context, input);
  }
}
