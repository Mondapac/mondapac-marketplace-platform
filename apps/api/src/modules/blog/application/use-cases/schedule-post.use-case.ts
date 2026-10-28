import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_PUBLISH } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { schedulePost } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.schedule-post`: Sets the instant the approved version goes live (the worker publishes it). */
export class ScheduleBlogPost extends UseCase<
  FlowInput<typeof schedulePost>,
  FlowValue<typeof schedulePost>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.schedule-post',
    rule: { kind: 'permissions', allOf: [BLOG_POST_PUBLISH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof schedulePost>) {
    return schedulePost(this.deps, context, input);
  }
}
