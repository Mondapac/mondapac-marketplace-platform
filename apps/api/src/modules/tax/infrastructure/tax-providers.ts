import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  STRATEGY_REPOSITORY,
  type StrategyRepository,
} from '../application/ports/strategy.repository';
import { TAX_POLICY, type TaxPolicy } from '../application/ports/tax-policy';
import { ConfigTaxPolicy } from './config-tax-policy';
import { PrismaStrategyRepository } from './prisma-strategy.repository';

/** Binds the ports of tax. Only this layer may reach `PrismaService`. */
export const taxProviders: readonly FactoryProvider[] = [
  {
    provide: STRATEGY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): StrategyRepository => new PrismaStrategyRepository(prisma),
  },
  {
    provide: TAX_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): TaxPolicy => new ConfigTaxPolicy(markets),
  },
];
