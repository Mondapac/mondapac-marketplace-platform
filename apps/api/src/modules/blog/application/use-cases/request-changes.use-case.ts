import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_REVIEW } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { requestChanges } from '../review-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.request-changes`: Sends the version back to its author with a note. */
export class RequestBlogPostChanges extends UseCase<
  FlowInput<typeof requestChanges>,
  FlowValue<typeof requestChanges>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.request-changes',
    rule: { kind: 'permissions', allOf: [BLOG_POST_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof requestChanges>) {
    return requestChanges(this.deps, context, input);
  }
}
