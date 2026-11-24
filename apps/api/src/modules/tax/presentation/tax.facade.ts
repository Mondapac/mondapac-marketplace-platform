import type { CallContext } from '@mondapac/shared-kernel';
import type { CalculateTax } from '../application/use-cases/calculate-tax.use-case';
import type { CategoryRates } from '../application/use-cases/category-rates.use-case';
import type { ReverseRefundTax } from '../application/use-cases/reverse-refund-tax.use-case';
import type { RefundChargeInput, RefundLineInput, TaxFacade, TaxLineInput } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class TaxFacadeImplementation implements TaxFacade {
  constructor(
    private readonly calculate: CalculateTax,
    private readonly reverse: ReverseRefundTax,
    private readonly rates: CategoryRates,
  ) {}

  calculateTax(context: CallContext, lines: readonly TaxLineInput[]) {
    return this.calculate.execute(context, { lines });
  }

  categoryRates(context: CallContext, codes: readonly (string | null)[]) {
    return this.rates.execute(context, { codes });
  }

  reverseRefundTax(
    context: CallContext,
    input: {
      readonly lines: readonly RefundLineInput[];
      readonly charges: readonly RefundChargeInput[];
    },
  ) {
    return this.reverse.execute(context, { lines: input.lines, charges: input.charges });
  }
}
