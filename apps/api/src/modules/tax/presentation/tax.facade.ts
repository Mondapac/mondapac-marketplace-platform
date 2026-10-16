import type { CallContext } from '@mondapac/shared-kernel';
import type { CalculateTax } from '../application/use-cases/calculate-tax.use-case';
import type { TaxFacade, TaxLineInput } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class TaxFacadeImplementation implements TaxFacade {
  constructor(private readonly calculate: CalculateTax) {}

  calculateTax(context: CallContext, lines: readonly TaxLineInput[]) {
    return this.calculate.execute(context, { lines });
  }
}
