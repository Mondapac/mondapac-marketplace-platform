import { revealCostMinor, type CostAmount } from '../../../domain/cost/cost-amount';

/** The wire form of a Cost: minor units as a string, in the Market currency (design 6.5). */
export interface CostWire {
  readonly amount: string;
  readonly currency: string;
}

/**
 * The only reader of a {@link CostAmount} outside the domain and the Cost repository (pricing
 * design 6.5): builds the wire DTO of the seller's own Cost route, and nothing else. Never call
 * it for a log, an event, an audit row, an export or any other route.
 */
export const CostPresenter = {
  wire(cost: CostAmount | null): CostWire | null {
    if (cost === null) return null;
    const { amount, currency } = revealCostMinor(cost);
    return { amount: amount.toString(), currency };
  },
} as const;
