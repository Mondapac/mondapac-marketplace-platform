import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { ADMIN_KPI_READER, type AdminKpiReader } from '../application/ports/admin-kpi-reader';
import { FactRecorder } from '../application/fact-recorder';
import {
  BACKFILL_PROGRESS_STORE,
  type BackfillProgressStore,
} from '../application/ports/backfill-progress-store';
import { FACT_STORE, type FactStore } from '../application/ports/fact-store';
import { MARKET_ZONE, type MarketZone } from '../application/ports/market-zone';
import { ROLLUP_STORE, type RollupStore } from '../application/ports/rollup-store';
import { PrismaBackfillProgressStore } from './prisma-backfill-progress-store';
import { PrismaAdminKpiReader } from './prisma-admin-kpi-reader';
import { PrismaFactStore } from './prisma-fact-store';
import { SELLER_KPI_READER, type SellerKpiReader } from '../application/ports/seller-kpi-reader';
import { PrismaSellerKpiReader } from './prisma-seller-kpi-reader';
import { PrismaRollupStore } from './prisma-rollup-store';
import { RegistryMarketZone } from './registry-market-zone';

/** Binds the ports of reporting. Only this layer may reach `PrismaService`. */
export const reportingProviders: readonly FactoryProvider[] = [
  {
    provide: FACT_STORE,
    inject: [PrismaService, CLOCK],
    useFactory: (prisma: PrismaService, clock: Clock): FactStore =>
      new PrismaFactStore(prisma, () => clock.now()),
  },
  {
    provide: ROLLUP_STORE,
    inject: [PrismaService, CLOCK],
    useFactory: (prisma: PrismaService, clock: Clock): RollupStore =>
      new PrismaRollupStore(prisma, () => clock.now()),
  },
  {
    provide: ADMIN_KPI_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminKpiReader => new PrismaAdminKpiReader(prisma),
  },
  {
    provide: BACKFILL_PROGRESS_STORE,
    inject: [PrismaService, CLOCK],
    useFactory: (prisma: PrismaService, clock: Clock): BackfillProgressStore =>
      new PrismaBackfillProgressStore(prisma, () => clock.now()),
  },
  {
    provide: SELLER_KPI_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerKpiReader => new PrismaSellerKpiReader(prisma),
  },
  {
    provide: MARKET_ZONE,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): MarketZone => new RegistryMarketZone(markets),
  },
  {
    provide: FactRecorder,
    inject: [FACT_STORE, ROLLUP_STORE, MARKET_ZONE],
    useFactory: (facts: FactStore, rollups: RollupStore, zone: MarketZone): FactRecorder =>
      new FactRecorder({ facts, rollups, zone }),
  },
];
