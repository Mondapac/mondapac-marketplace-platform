import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readSellerSummaries,
  type SellerSummariesDependencies,
  type SellerSummariesFailure,
  type SellerSummary,
} from '../summaries/read-seller-summaries';
import type { SellerSummariesInput } from './seller-summaries.use-case';

/**
 * `sellerSummaries` for event handlers and jobs (sellers design 7.1; slice 1): rule `system`,
 * the pair of `SellerSummaries` behind the same facade method, which picks this one for the
 * system actor. The same read as its pair; it alone shows the draft's zone as provisional (Hassan L4).
 */
export class SellerSummariesSystem extends UseCase<
  SellerSummariesInput,
  readonly SellerSummary[],
  SellerSummariesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-summaries-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerSummariesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerSummariesInput,
  ): Promise<Result<readonly SellerSummary[], SellerSummariesFailure>> {
    return readSellerSummaries(this.deps, context, input.sellerIds, { provisionalZone: true });
  }
}
