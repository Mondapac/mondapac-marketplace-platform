import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_EDIT } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { setEventStatus } from '../publish-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.change-event-status`: Changes the status of a platform event at once, without review (audited). */
export class ChangeBlogEventStatus extends UseCase<
  FlowInput<typeof setEventStatus>,
  FlowValue<typeof setEventStatus>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.change-event-status',
    rule: { kind: 'permissions', allOf: [BLOG_POST_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof setEventStatus>) {
    return setEventStatus(this.deps, context, input, 'admin');
  }
}
