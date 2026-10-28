import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { viewUpcomingEvents } from '../public-flow';
import type { FlowValue } from '../flow-types';

/** `blog.view-upcoming-events`: Live event posts that have not ended, soonest first. */
export class ViewUpcomingBlogEvents extends UseCase<
  unknown,
  FlowValue<typeof viewUpcomingEvents>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.view-upcoming-events',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewUpcomingEvents(this.deps, context);
  }
}
