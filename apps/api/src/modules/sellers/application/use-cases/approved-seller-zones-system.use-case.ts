import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  approvedSellerZonesFor,
  type ApprovedSellerZonesDependencies,
  type ApprovedSellerZonesAnswer,
  type ApprovedSellerZonesFailure,
  type ApprovedSellerZonesInput,
} from './approved-seller-zones.use-case';

/** `approvedSellerZones` for event handlers and jobs: rule `system`, the same answer. */
export class ApprovedSellerZonesSystem extends UseCase<
  ApprovedSellerZonesInput,
  ApprovedSellerZonesAnswer,
  ApprovedSellerZonesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.approved-seller-zones-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ApprovedSellerZonesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ApprovedSellerZonesInput,
  ): Promise<Result<ApprovedSellerZonesAnswer, ApprovedSellerZonesFailure>> {
    return approvedSellerZonesFor(this.deps, context, input.sellerIds);
  }
}
