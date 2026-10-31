import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { batchCodeSummary, type BatchCodeSummary } from '../batch-code-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

export type { BatchCodeSummary };

/** `promotions.view-batch-code-summary`: how many codes a batch-code promotion holds and how many were used (counts only, never a code). */
export class ViewBatchCodeSummary extends UseCase<
  { readonly promotionId?: unknown },
  BatchCodeSummary,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-batch-code-summary',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly promotionId?: unknown },
  ): Promise<Result<BatchCodeSummary, PromotionsFailure>> {
    return batchCodeSummary(this.deps, context, input);
  }
}
