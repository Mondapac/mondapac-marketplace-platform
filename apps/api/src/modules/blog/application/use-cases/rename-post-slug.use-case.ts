import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { renameSlug } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.rename-post-slug`: Changes the address of a post that was published; the old address redirects. */
export class RenameBlogPostSlug extends UseCase<
  FlowInput<typeof renameSlug>,
  FlowValue<typeof renameSlug>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.rename-post-slug',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof renameSlug>) {
    return renameSlug(this.deps, context, input);
  }
}
