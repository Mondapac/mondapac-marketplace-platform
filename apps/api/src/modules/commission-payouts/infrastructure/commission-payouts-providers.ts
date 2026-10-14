import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { COMMISSION_POLICY, type CommissionPolicy } from '../application/ports/commission-policy';
import { LEDGER_REPOSITORY, type LedgerRepository } from '../application/ports/ledger.repository';
import { SELLER_DIRECTORY, type SellerDirectory } from '../application/ports/seller-directory';
import {
  SELLER_RATE_REPOSITORY,
  type SellerRateRepository,
} from '../application/ports/seller-rate.repository';
import { ConfigCommissionPolicy } from './config-commission-policy';
import { PrismaLedgerRepository } from './prisma-ledger.repository';
import { PrismaSellerRateRepository } from './prisma-seller-rate.repository';
import { SellersSellerDirectory } from './sellers-seller-directory';

/** Binds the ports of commission-payouts. Only this layer may reach `PrismaService`. */
export const commissionPayoutsProviders: readonly FactoryProvider[] = [
  {
    provide: SELLER_RATE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SellerRateRepository =>
      new PrismaSellerRateRepository(prisma),
  },
  {
    provide: LEDGER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): LedgerRepository => new PrismaLedgerRepository(prisma),
  },
  {
    provide: COMMISSION_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): CommissionPolicy => new ConfigCommissionPolicy(markets),
  },
  {
    provide: SELLER_DIRECTORY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerDirectory => new SellersSellerDirectory(sellers),
  },
];
