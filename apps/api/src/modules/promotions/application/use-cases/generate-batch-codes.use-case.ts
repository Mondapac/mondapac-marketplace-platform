import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import { generateBatchCodes, type GeneratedBatch } from '../batch-code-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

export type { GeneratedBatch };

/** `promotions.generate-batch-codes`: an admin generates unique single-use codes for a batch-code promotion. The plain codes are in this answer only; a promotion whose platform budget is above the Market threshold needs a fresh two-step code for each call. */
export class GenerateBatchCodes extends UseCase<
  { readonly promotionId?: unknown; readonly count?: unknown },
  GeneratedBatch,
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.generate-batch-codes',
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
    input: { readonly promotionId?: unknown; readonly count?: unknown },
  ): Promise<Result<GeneratedBatch, PromotionsFailure>> {
    return generateBatchCodes(this.deps, context, input);
  }
}
