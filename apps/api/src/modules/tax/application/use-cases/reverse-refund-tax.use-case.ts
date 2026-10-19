import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RefundTaxAnswer, TaxFailure } from '../../contracts/tax.facade';
import { reverseRefundTax } from '../reverse-flow';

/**
 * `tax.reverse-refund-tax`: the tax a refund reverses, from frozen values only (tax design 4.8).
 * Rule `anonymous`: the answer is arithmetic on its input, reads nothing and returns no personal
 * data; `ordering` checks who may refund before calling (design 5.2). Not exposed over HTTP.
 */
export class ReverseRefundTax extends UseCase<
  { readonly lines: unknown; readonly charges: unknown },
  RefundTaxAnswer,
  TaxFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.reverse-refund-tax',
    rule: { kind: 'anonymous' },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    _context: CallContext,
    input: { readonly lines: unknown; readonly charges: unknown },
  ) {
    return Promise.resolve(reverseRefundTax(input));
  }
}
