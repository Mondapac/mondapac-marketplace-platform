import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { setFeatured } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.feature-post`: Makes a published post the featured one of the Market, or not. */
export class FeatureBlogPost extends UseCase<
  FlowInput<typeof setFeatured>,
  FlowValue<typeof setFeatured>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.feature-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof setFeatured>) {
    return setFeatured(this.deps, context, input);
  }
}
