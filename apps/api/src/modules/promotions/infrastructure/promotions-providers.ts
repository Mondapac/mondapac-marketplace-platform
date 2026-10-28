import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { BATCH_CODE_CRYPTO, type BatchCodeCrypto } from '../application/ports/batch-code-crypto';
import {
  BATCH_CODE_REPOSITORY,
  type BatchCodeRepository,
} from '../application/ports/batch-code.repository';
import { FLASH_SALES, type FlashSales } from '../application/ports/flash-sales';
import {
  MARKET_SETTING_REPOSITORY,
  type MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import { OPT_IN_REPOSITORY, type OptInRepository } from '../application/ports/opt-in.repository';
import { PRICE_HISTORY, type PriceHistory } from '../application/ports/price-history';
import {
  PROMOTION_REPOSITORY,
  type PromotionRepository,
} from '../application/ports/promotion.repository';
import { PROMOTIONS_POLICY, type PromotionsPolicy } from '../application/ports/promotions-policy';
import {
  REVIEW_QUEUE_REPOSITORY,
  type ReviewQueueRepository,
} from '../application/ports/review-queue.repository';
import { SELLER_ACTIVITY, type SellerActivity } from '../application/ports/seller-activity';
import {
  FIRST_ORDER_SETTINGS_REPOSITORY,
  SHIPPING_THRESHOLD_REPOSITORY,
  type FirstOrderSettingsRepository,
  type ShippingThresholdRepository,
} from '../application/ports/settings.repository';
import { ConfigPromotionsPolicy } from './config-promotions-policy';
import { PrismaMarketSettingRepository } from './prisma-market-setting.repository';
import { PrismaOptInRepository } from './prisma-opt-in.repository';
import { PrismaPromotionRepository } from './prisma-promotion.repository';
import { PrismaReviewQueueRepository } from './prisma-review-queue.repository';
import {
  PrismaFirstOrderSettingsRepository,
  PrismaShippingThresholdRepository,
} from './prisma-settings.repository';
import { CryptoBatchCodeCrypto } from './crypto-batch-code-crypto';
import { PrismaBatchCodeRepository } from './prisma-batch-code.repository';
import {
  UnknownFlashSales,
  UnknownPriceHistory,
  UnknownSellerActivity,
} from './unavailable-adapters';

/** Binds the ports of promotions. Only this layer may reach `PrismaService`. */
export const promotionsProviders: readonly FactoryProvider[] = [
  {
    provide: PROMOTION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PromotionRepository =>
      new PrismaPromotionRepository(prisma),
  },
  {
    provide: OPT_IN_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OptInRepository => new PrismaOptInRepository(prisma),
  },
  {
    provide: REVIEW_QUEUE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReviewQueueRepository =>
      new PrismaReviewQueueRepository(prisma),
  },
  {
    provide: MARKET_SETTING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MarketSettingRepository =>
      new PrismaMarketSettingRepository(prisma),
  },
  {
    provide: FIRST_ORDER_SETTINGS_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): FirstOrderSettingsRepository =>
      new PrismaFirstOrderSettingsRepository(prisma),
  },
  {
    provide: SHIPPING_THRESHOLD_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ShippingThresholdRepository =>
      new PrismaShippingThresholdRepository(prisma),
  },
  {
    provide: PROMOTIONS_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): PromotionsPolicy => new ConfigPromotionsPolicy(markets),
  },
  {
    provide: BATCH_CODE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BatchCodeRepository =>
      new PrismaBatchCodeRepository(prisma),
  },
  {
    provide: BATCH_CODE_CRYPTO,
    useFactory: (): BatchCodeCrypto => new CryptoBatchCodeCrypto(),
  },
  {
    provide: FLASH_SALES,
    useFactory: (): FlashSales => new UnknownFlashSales(),
  },
  {
    provide: SELLER_ACTIVITY,
    useFactory: (): SellerActivity => new UnknownSellerActivity(),
  },
  {
    provide: PRICE_HISTORY,
    useFactory: (): PriceHistory => new UnknownPriceHistory(),
  },
];
