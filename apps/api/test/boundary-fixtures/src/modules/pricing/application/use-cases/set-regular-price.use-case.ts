// Fixture: a price use case must not load a Cost (pricing-cost-store-only-in-cost-use-cases).
import type { CostSeriesRepository } from '../ports/cost-series.repository';

export type PriceWrite = (store: CostSeriesRepository) => void;
