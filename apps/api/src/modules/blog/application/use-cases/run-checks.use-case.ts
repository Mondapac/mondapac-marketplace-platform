import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BLOG_POST_REVIEW } from '../../contracts/permissions';
import type { BlogDependencies } from '../blog-dependencies';
import type { BlogFailure } from '../failures';
import { runPostChecks } from '../review-flow';
import type { FlowInput, FlowValue } from '../flow-types';

/** `blog.run-checks`: Runs the automatic checks on the version in work and answers every finding. */
export class RunBlogPostChecks extends UseCase<
  FlowInput<typeof runPostChecks>,
  FlowValue<typeof runPostChecks>,
  BlogFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'blog.run-checks',
    rule: { kind: 'permissions', allOf: [BLOG_POST_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: FlowInput<typeof runPostChecks>) {
    return runPostChecks(this.deps, context, input);
  }
}
