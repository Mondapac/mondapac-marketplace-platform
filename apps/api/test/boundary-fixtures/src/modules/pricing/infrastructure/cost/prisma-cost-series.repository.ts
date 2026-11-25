// Fixture: the Cost store implements the port and holds the type.
import type { CostSeriesRepository } from '../../application/ports/cost-series.repository';
import type { CostAmount } from '../../domain/cost/cost-amount';

export type CostStore = CostSeriesRepository & { last?: CostAmount };
