import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MARKET_SETTING_REPOSITORY,
  type MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import { PrismaMarketSettingRepository } from './prisma-market-setting.repository';

/** Binds the ports of settings. Only this layer may reach `PrismaService`. */
export const settingsProviders: readonly FactoryProvider[] = [
  {
    provide: MARKET_SETTING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MarketSettingRepository =>
      new PrismaMarketSettingRepository(prisma),
  },
];
