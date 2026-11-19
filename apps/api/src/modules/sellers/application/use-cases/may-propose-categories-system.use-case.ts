import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  mayProposeCategoriesFor,
  type MayProposeCategoriesDependencies,
  type MayProposeCategoriesFailure,
  type MayProposeCategoriesInput,
} from './may-propose-categories.use-case';

/** `mayProposeCategories` for event handlers and jobs: rule `system`, the same answer. */
export class MayProposeCategoriesSystem extends UseCase<
  MayProposeCategoriesInput,
  boolean,
  MayProposeCategoriesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.may-propose-categories-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MayProposeCategoriesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: MayProposeCategoriesInput,
  ): Promise<Result<boolean, MayProposeCategoriesFailure>> {
    return mayProposeCategoriesFor(this.deps, context, input.sellerId);
  }
}
