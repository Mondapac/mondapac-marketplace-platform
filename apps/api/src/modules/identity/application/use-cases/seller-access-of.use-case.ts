import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readSellerAccess,
  type SellerAccessOfDependencies,
  type SellerAccessOfFailure,
  type SellerAccessSummary,
} from '../sellers/read-seller-access';

export interface SellerAccessOfInput {
  readonly sellerIds: readonly string[];
}

/**
 * `sellerAccessOf` for request actors (identity design 8.1, 8.3; ADR-0022 decision 2; slice 5):
 * the may-sell contract asks it during a customer's request, so the rule is `anonymous` and the
 * gate passes the Market's anonymous actor whoever calls (HF9). Its pair for handlers is
 * `SellerAccessOfSystem`. Never over HTTP. State codes and instants of registered sellers
 * only; never a reason (decision 9).
 */
export class SellerAccessOf extends UseCase<
  SellerAccessOfInput,
  readonly SellerAccessSummary[],
  SellerAccessOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.seller-access-of',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerAccessOfDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerAccessOfInput,
  ): Promise<Result<readonly SellerAccessSummary[], SellerAccessOfFailure>> {
    return readSellerAccess(this.deps, context, input.sellerIds);
  }
}
