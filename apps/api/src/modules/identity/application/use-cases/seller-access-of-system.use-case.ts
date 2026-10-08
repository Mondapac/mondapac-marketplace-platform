import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  readSellerAccess,
  type SellerAccessOfDependencies,
  type SellerAccessOfFailure,
  type SellerAccessSummary,
} from '../sellers/read-seller-access';
import type { SellerAccessOfInput } from './seller-access-of.use-case';

/**
 * `sellerAccessOf` for event handlers and jobs (identity design 8.1; slice 5): rule `system`,
 * the pair of `SellerAccessOf` behind the same facade method, which picks this one for the
 * system actor. The same read: state codes and instants of registered sellers only.
 */
export class SellerAccessOfSystem extends UseCase<
  SellerAccessOfInput,
  readonly SellerAccessSummary[],
  SellerAccessOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.seller-access-of-system',
    rule: { kind: 'system' },
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
