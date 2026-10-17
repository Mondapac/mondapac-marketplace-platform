import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import {
  INVENTORY_POLICY_PROVIDER,
  type InventoryPolicyProvider,
} from '../application/ports/inventory-policy-provider';
import { ConfigInventoryPolicyProvider } from './config-inventory-policy-provider';
import {
  SELL_UNIT_LABELS_SOURCE,
  type SellUnitLabelsSource,
} from '../application/ports/sell-unit-labels';
import { CatalogSellUnitLabels } from './catalog-sell-unit-labels';
import {
  SELLER_INVENTORY_REPOSITORY,
  type SellerInventoryRepository,
} from '../application/ports/seller-inventory.repository';
import { PrismaSellerInventoryRepository } from './prisma-seller-inventory.repository';
import {
  AVAILABILITY_SIGNAL_REPOSITORY,
  type AvailabilitySignalRepository,
} from '../application/ports/availability-signal.repository';
import {
  OFFER_SELL_UNITS_SOURCE,
  type OfferSellUnitsSource,
} from '../application/ports/offer-sell-units';
import {
  AVAILABILITY_READER,
  type AvailabilityReader,
} from '../application/ports/availability-reader';
import { STOCK_REPOSITORY, type StockRepository } from '../application/ports/stock.repository';
import { OFFER_STOCK_READER, type OfferStockReader } from '../application/ports/offer-stock.reader';
import { PrismaOfferStockReader } from './prisma-offer-stock.reader';
import { CatalogOfferSellUnits } from './catalog-offer-sell-units';
import { PrismaAvailabilityReader } from './prisma-availability.reader';
import { PrismaAvailabilitySignalRepository } from './prisma-availability-signal.repository';
import { PrismaStockRepository } from './prisma-stock.repository';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../application/ports/reservation.repository';
import { PrismaReservationRepository } from './prisma-reservation.repository';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { RATE_COUNTER_KEYS, type RateCounterKeys } from '../application/ports/rate-counter-keys';
import {
  RATE_COUNTER_REPOSITORY,
  type RateCounterRepository,
} from '../application/ports/rate-counter.repository';
import { HmacRateCounterKeys, localInventorySecret } from './hmac-rate-counter-keys';
import { PrismaRateCounterRepository } from './prisma-rate-counter.repository';

const INVENTORY_SECRET = Symbol('INVENTORY_SECRET');

/**
 * Binds the ports of slices 1, 2 and 4. They live in `infrastructure/` because only this layer may reach
 * `PrismaService` (dependency-cruiser `persistence-internals-are-private`).
 */
export const inventoryProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_INVENTORY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerInventoryRepository =>
      new PrismaSellerInventoryRepository(prisma),
  },
  {
    provide: STOCK_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): StockRepository => new PrismaStockRepository(prisma),
  },
  {
    provide: OFFER_STOCK_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferStockReader => new PrismaOfferStockReader(prisma),
  },
  {
    provide: RESERVATION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReservationRepository =>
      new PrismaReservationRepository(prisma),
  },
  {
    provide: AVAILABILITY_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AvailabilityReader => new PrismaAvailabilityReader(prisma),
  },
  {
    provide: AVAILABILITY_SIGNAL_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AvailabilitySignalRepository =>
      new PrismaAvailabilitySignalRepository(prisma),
  },
  {
    provide: OFFER_SELL_UNITS_SOURCE,
    inject: [CATALOG_FACADE],
    useFactory: (catalog: CatalogFacade): OfferSellUnitsSource =>
      new CatalogOfferSellUnits(catalog),
  },
  {
    provide: SELL_UNIT_LABELS_SOURCE,
    inject: [CATALOG_FACADE, MarketRegistry],
    useFactory: (catalog: CatalogFacade, markets: MarketRegistry): SellUnitLabelsSource =>
      new CatalogSellUnitLabels(catalog, markets),
  },
  {
    provide: INVENTORY_POLICY_PROVIDER,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): InventoryPolicyProvider =>
      new ConfigInventoryPolicyProvider(markets),
  },
  {
    provide: RATE_COUNTER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RateCounterRepository =>
      new PrismaRateCounterRepository(prisma),
  },
  {
    // The local stand-in of the inventory stack secret refuses production (K1).
    provide: INVENTORY_SECRET,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): Uint8Array => localInventorySecret(config),
  },
  {
    provide: RATE_COUNTER_KEYS,
    inject: [INVENTORY_SECRET],
    useFactory: (secret: Uint8Array): RateCounterKeys => new HmacRateCounterKeys(secret),
  },
];
