// Fixture: pricing's Cost repository port (pricing design 6.5).
import type { CostAmount } from '../../domain/cost/cost-amount';

export interface CostSeriesRepository {
  current(): Promise<CostAmount | null>;
}
