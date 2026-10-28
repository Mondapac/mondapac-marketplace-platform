import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { unschedulePost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.unschedule-post`: Removes the schedule; the version stays approved. */
export class UnscheduleBlogPost extends UseCase<
  FlowInput<typeof unschedulePost>,
  FlowValue<typeof unschedulePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.unschedule-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof unschedulePost>) {
    return unschedulePost(this.deps, context, input);
  }
}
