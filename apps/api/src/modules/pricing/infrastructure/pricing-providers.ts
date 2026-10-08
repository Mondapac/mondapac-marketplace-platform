import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  PRICE_SERIES_REPOSITORY,
  type PriceSeriesRepository,
} from '../application/ports/price-series.repository';
import {
  RETIREMENT_TOMBSTONE_REPOSITORY,
  type RetirementTombstoneRepository,
} from '../application/ports/retirement-tombstone.repository';
import {
  WRITE_REFUSAL_THROTTLE_REPOSITORY,
  type WriteRefusalThrottleRepository,
} from '../application/ports/write-refusal-throttle.repository';
import {
  PRICING_POLICY_PROVIDER,
  type PricingPolicyProvider,
} from '../application/ports/pricing-policy-provider';
import { ConfigPricingPolicyProvider } from './config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from './prisma-price-series.repository';
import { PrismaRetirementTombstoneRepository } from './prisma-retirement-tombstone.repository';
import { PrismaWriteRefusalThrottleRepository } from './prisma-write-refusal-throttle.repository';

/**
 * Binds the persistence ports of slice 1 (part 2). They live in `infrastructure/` because only
 * this layer may reach `PrismaService` (dependency-cruiser `persistence-internals-are-private`).
 * The module registers them with its use cases in part 3; until then nothing injects them.
 */
export const pricingProviders: readonly FactoryProvider[] = [
  {
    provide: PRICE_SERIES_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PriceSeriesRepository =>
      new PrismaPriceSeriesRepository(prisma),
  },
  {
    provide: RETIREMENT_TOMBSTONE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RetirementTombstoneRepository =>
      new PrismaRetirementTombstoneRepository(prisma),
  },
  {
    provide: WRITE_REFUSAL_THROTTLE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): WriteRefusalThrottleRepository =>
      new PrismaWriteRefusalThrottleRepository(prisma),
  },
  {
    provide: PRICING_POLICY_PROVIDER,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): PricingPolicyProvider =>
      new ConfigPricingPolicyProvider(markets),
  },
];
