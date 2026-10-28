import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { publishDue } from '../publish-flow';
import type { FlowValue } from '../flow-types';

/** `blog.publish-due`: The worker publishes the approved versions whose scheduled instant has come; idempotent. */
export class PublishDueBlogPosts extends UseCase<
  unknown,
  FlowValue<typeof publishDue>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.publish-due',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return publishDue(this.deps, context);
  }
}
