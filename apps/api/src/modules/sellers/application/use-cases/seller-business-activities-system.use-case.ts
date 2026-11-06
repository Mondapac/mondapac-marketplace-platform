import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sellerBusinessActivitiesFor,
  type SellerBusinessActivitiesDependencies,
  type SellerBusinessActivitiesFailure,
  type SellerBusinessActivitiesInput,
  type SellerBusinessActivitiesMap,
} from './seller-business-activities.use-case';

/** `sellerBusinessActivities` for event handlers and jobs: rule `system`, the same answer. */
export class SellerBusinessActivitiesSystem extends UseCase<
  SellerBusinessActivitiesInput,
  SellerBusinessActivitiesMap,
  SellerBusinessActivitiesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-business-activities-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerBusinessActivitiesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerBusinessActivitiesInput,
  ): Promise<Result<SellerBusinessActivitiesMap, SellerBusinessActivitiesFailure>> {
    return sellerBusinessActivitiesFor(this.deps, context, input?.sellerIds);
  }
}
