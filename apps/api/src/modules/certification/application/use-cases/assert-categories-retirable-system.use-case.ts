import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CategoryRetirementRepository } from '../ports/category-retirement.repository';
import {
  assertRetirable,
  type AssertCategoriesRetirableFailure,
  type CategoryIdsInput,
} from './assert-categories-retirable.use-case';

/** `assertCategoriesRetirable` for handlers and jobs: rule `system`; the same answer. */
export class AssertCategoriesRetirableSystem extends UseCase<
  CategoryIdsInput,
  void,
  AssertCategoriesRetirableFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.assert-categories-retirable-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly repository: CategoryRetirementRepository,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CategoryIdsInput,
  ): Promise<Result<void, AssertCategoriesRetirableFailure>> {
    return assertRetirable(this.repository, context, input);
  }
}
