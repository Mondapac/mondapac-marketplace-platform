// Fixture: a Cost use case may use the Cost store and the Cost type.
import type { CostSeriesRepository } from '../ports/cost-series.repository';
import type { CostAmount } from '../../domain/cost/cost-amount';

export type CostRead = (store: CostSeriesRepository) => Promise<CostAmount | null>;
