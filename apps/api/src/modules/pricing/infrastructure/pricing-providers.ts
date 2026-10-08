import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import {
  OFFER_SELL_UNITS_SOURCE,
  type OfferSellUnitsSource,
} from '../application/ports/offer-sell-units';
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
import { CatalogOfferSellUnits } from './catalog-offer-sell-units';
import { ConfigPricingPolicyProvider } from './config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from './prisma-price-series.repository';
import { PrismaRetirementTombstoneRepository } from './prisma-retirement-tombstone.repository';
import { PrismaWriteRefusalThrottleRepository } from './prisma-write-refusal-throttle.repository';

/**
 * Binds the ports of slice 1: persistence (part 2; in `infrastructure/` because only this layer
 * may reach `PrismaService`, dependency-cruiser `persistence-internals-are-private`), the Market
 * policy (part 3a) and catalog's `offerSellUnits` behind pricing's own port (part 3b; catalog's
 * production binding is its fail-closed placeholder until catalog slice 7, ADR-0031 decision 6).
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
    provide: OFFER_SELL_UNITS_SOURCE,
    inject: [CATALOG_FACADE],
    useFactory: (catalog: CatalogFacade): OfferSellUnitsSource =>
      new CatalogOfferSellUnits(catalog),
  },
  {
    provide: PRICING_POLICY_PROVIDER,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): PricingPolicyProvider =>
      new ConfigPricingPolicyProvider(markets),
  },
];
