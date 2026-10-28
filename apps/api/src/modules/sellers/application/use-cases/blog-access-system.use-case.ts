import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  blogAccessFor,
  type BlogAccessDependencies,
  type BlogAccessFailure,
  type BlogAccessInput,
} from './blog-access.use-case';

/** `blogAccessOf` for event handlers and jobs: rule `system`, the same answer. */
export class BlogAccessSystem extends UseCase<BlogAccessInput, boolean, BlogAccessFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.blog-access-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: BlogAccessInput,
  ): Promise<Result<boolean, BlogAccessFailure>> {
    return blogAccessFor(this.deps, context, input.sellerId);
  }
}
