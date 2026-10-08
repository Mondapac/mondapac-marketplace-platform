import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readSellerSummaries,
  type SellerSummariesDependencies,
  type SellerSummariesFailure,
  type SellerSummary,
} from '../summaries/read-seller-summaries';

export interface SellerSummariesInput {
  readonly sellerIds: readonly string[];
}

/**
 * `sellerSummaries` for request actors (sellers design 7.1; slice 1): rule `anonymous`, so the
 * gate passes the Market's anonymous actor whoever calls, as for `identity.sellerAccessOf`. Its
 * pair for handlers and jobs is `SellerSummariesSystem`, which also shows the draft's provisional zone; this one does not (Hassan L4; the anonymous rule hides authenticated callers too). Never over HTTP.
 */
export class SellerSummaries extends UseCase<
  SellerSummariesInput,
  readonly SellerSummary[],
  SellerSummariesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-summaries',
    rule: { kind: 'anonymous' },
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
    return readSellerSummaries(this.deps, context, input.sellerIds, { provisionalZone: false });
  }
}
