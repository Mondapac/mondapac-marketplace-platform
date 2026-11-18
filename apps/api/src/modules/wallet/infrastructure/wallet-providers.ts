import type { FactoryProvider } from '@nestjs/common';
import type { IdGenerator } from '@mondapac/shared-kernel';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../../platform/list-export';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  ADMIN_CREDIT_REPOSITORY,
  type AdminCreditRepository,
} from '../application/ports/admin-credit.repository';
import {
  ADMIN_CREDIT_LIST_READER,
  type AdminCreditListReader,
} from '../application/ports/admin-credit-list.reader';
import {
  MARKET_SETTING_REPOSITORY,
  type MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import { WALLET_POLICY, type WalletPolicy } from '../application/ports/wallet-policy';
import { WALLET_REPOSITORY, type WalletRepository } from '../application/ports/wallet.repository';
import { ConfigWalletPolicy } from './config-wallet-policy';
import { PrismaAdminCreditListReader } from './prisma-admin-credit-list.reader';
import { PrismaAdminCreditRepository } from './prisma-admin-credit.repository';
import { PrismaMarketSettingRepository } from './prisma-market-setting.repository';
import { PrismaWalletRepository } from './prisma-wallet.repository';

/** Binds the ports of wallet. Only this layer may reach `PrismaService`. */
export const walletProviders: readonly FactoryProvider[] = [
  {
    provide: WALLET_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): WalletRepository =>
      new PrismaWalletRepository(prisma, ids),
  },
  {
    provide: MARKET_SETTING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MarketSettingRepository =>
      new PrismaMarketSettingRepository(prisma),
  },
  {
    provide: ADMIN_CREDIT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminCreditRepository =>
      new PrismaAdminCreditRepository(prisma),
  },
  {
    provide: ADMIN_CREDIT_LIST_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): AdminCreditListReader =>
      new PrismaAdminCreditListReader(prisma),
  },
  {
    // The super list export (CSV and XLSX): every cell a string value, never a formula.
    provide: SHEET_WRITER,
    useFactory: (): SheetWriter => new ExceljsSheetWriter(),
  },
  {
    provide: WALLET_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): WalletPolicy => new ConfigWalletPolicy(markets),
  },
];
