// Fixture: the Cost presenter reads the Cost type.
import type { CostAmount } from '../../../domain/cost/cost-amount';

export type Presented = (cost: CostAmount) => string;
