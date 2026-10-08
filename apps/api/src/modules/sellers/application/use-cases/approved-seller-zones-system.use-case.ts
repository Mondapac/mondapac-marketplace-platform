import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  approvedSellerZonesFor,
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

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    _context: CallContext,
    input: ApprovedSellerZonesInput,
  ): Promise<Result<ApprovedSellerZonesAnswer, ApprovedSellerZonesFailure>> {
    return Promise.resolve(approvedSellerZonesFor(input.sellerIds));
  }
}
