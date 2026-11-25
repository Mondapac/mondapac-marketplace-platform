// Fixture: contracts/ must not reach a Cost type (pricing-cost-type-only-on-cost-paths).
import type { CostAmount } from '../domain/cost/cost-amount';

export type Leaked = CostAmount;
