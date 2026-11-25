import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  COST_SERIES_REPOSITORY,
  type CostSeriesRepository,
} from '../../application/ports/cost-series.repository';
import { PrismaCostSeriesRepository } from './prisma-cost-series.repository';

/** Binds the Cost store (slice 3; pricing-data 3.7). Kept apart from the price ports (design 6.5). */
export const costProviders: readonly FactoryProvider[] = [
  {
    provide: COST_SERIES_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CostSeriesRepository =>
      new PrismaCostSeriesRepository(prisma),
  },
];
