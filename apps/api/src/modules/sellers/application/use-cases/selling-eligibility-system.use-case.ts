import type { CallContext, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseSellerIds } from '../summaries/read-seller-summaries';
import {
  answerFor,
  type SellingEligibilityAnswer,
  type SellingEligibilityFailure,
  type SellingEligibilityInput,
} from './selling-eligibility.use-case';

/** `sellingEligibility` for event handlers and jobs: rule `system`, the same answer. */
export class SellingEligibilitySystem extends UseCase<
  SellingEligibilityInput,
  SellingEligibilityAnswer,
  SellingEligibilityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.selling-eligibility-system',
    rule: { kind: 'system' },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    _context: CallContext,
    input: SellingEligibilityInput,
  ): Promise<Result<SellingEligibilityAnswer, SellingEligibilityFailure>> {
    const ids = parseSellerIds(input.sellerIds);
    return Promise.resolve(ids.ok ? ok(answerFor(ids.value)) : ids);
  }
}
