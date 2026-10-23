import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sellingEligibilityFor,
  type SellingEligibilityAnswer,
  type SellingEligibilityDependencies,
  type SellingEligibilityFailure,
  type SellingEligibilityInput,
  type SellingEligibilityUnavailable,
} from './selling-eligibility.use-case';

/**
 * `sellingEligibility` for event handlers and jobs: rule `system`, the same answer, except that a
 * failed read is `sellers.unavailable` (the delivery or job is retried) rather than all "no".
 */
export class SellingEligibilitySystem extends UseCase<
  SellingEligibilityInput,
  SellingEligibilityAnswer,
  SellingEligibilityFailure | SellingEligibilityUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.selling-eligibility-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellingEligibilityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellingEligibilityInput,
  ): Promise<
    Result<SellingEligibilityAnswer, SellingEligibilityFailure | SellingEligibilityUnavailable>
  > {
    return sellingEligibilityFor(this.deps, context, input.sellerIds, { faults: 'unavailable' });
  }
}
