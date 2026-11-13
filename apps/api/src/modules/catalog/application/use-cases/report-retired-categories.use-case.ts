import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CategoryRetirementCheck } from '../ports/category-retirement-check';

export interface ReportRetiredCategoriesInput {
  readonly delivery: EventDelivery;
  readonly categoryIds: readonly Id<'Category'>[];
}

export type ReportRetiredCategoriesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'category.check-unavailable' };

export interface ReportRetiredCategoriesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly retirement: CategoryRetirementCheck;
}

/**
 * `catalog.report-retired-categories` (categories package C4a; certification request C-4; catalog
 * design 4.6): catalog's own handler of its `platform-category-moved.v1`, `-merged.v1` and `-archived.v1`, with the payload's `checkedIds`.
 * Rule `system`; the Market is the envelope's. It calls certification's backstop
 * `platformCategoriesRetired` with the retired id outside any unit (idempotent there), then marks
 * the delivery handled in catalog's inbox. A refusal or fault answers
 * `category.check-unavailable`, so the delivery is retried. Badges were already marked
 * `rechecking` in the change's unit, and the fan-out job asks again (M1); nothing is asked here.
 */
export class ReportRetiredCategories extends UseCase<
  ReportRetiredCategoriesInput,
  { readonly handled: boolean },
  ReportRetiredCategoriesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.report-retired-categories',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReportRetiredCategories');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReportRetiredCategoriesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReportRetiredCategoriesInput,
  ): Promise<Result<{ readonly handled: boolean }, ReportRetiredCategoriesFailure>> {
    const reported = await this.deps.retirement.retired(context, input.categoryIds);
    if (!reported.ok) {
      this.#logger.warn({
        msg: 'catalog.report-retired-categories',
        code: reported.error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err(reported.error);
    }
    const marked = await this.deps.unitOfWork.runOnce(context.market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) return err({ code: 'category.check-unavailable' });
    return ok({ handled: marked.value.handled });
  }
}
