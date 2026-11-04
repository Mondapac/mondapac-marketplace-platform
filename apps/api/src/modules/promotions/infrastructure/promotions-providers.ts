import type { FactoryProvider } from '@nestjs/common';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PRICING_FACADE, type PricingFacade } from '../../pricing';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { WALLET_FACADE, type WalletFacade } from '../../wallet';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { BATCH_CODE_CRYPTO, type BatchCodeCrypto } from '../application/ports/batch-code-crypto';
import {
  BATCH_CODE_REPOSITORY,
  type BatchCodeRepository,
} from '../application/ports/batch-code.repository';
import {
  CREDIT_REPOSITORY,
  REFERRAL_REPOSITORY,
  type CreditRepository,
  type ReferralRepository,
} from '../application/ports/credit.repository';
import {
  CUSTOMER_ORDER_HISTORY,
  STORE_FOLLOWS,
  type CustomerOrderHistory,
  type StoreFollows,
} from '../application/ports/customer-facts';
import { DELIVERED_ORDER_FACTS, type DeliveredOrderFacts } from '../application/ports/order-facts';
import { REFERRAL_SIGNALS, type ReferralSignals } from '../application/ports/referral-signals';
import { WALLET_CREDIT, type WalletCredit } from '../application/ports/wallet-credit';
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
import { FacadeWalletCredit } from './facade-wallet-credit';
import { PrismaCreditRepository } from './prisma-credit.repository';
import { PrismaReferralRepository } from './prisma-referral.repository';
import {
  UnknownCustomerOrderHistory,
  UnknownDeliveredOrderFacts,
  UnknownReferralSignals,
  UnknownStoreFollows,
} from './unknown-customer-facts';
import { FacadePriceHistory, FacadeSellerActivity } from './facade-seller-price-reads';
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
import { UnknownFlashSales } from './unknown-flash-sales';

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
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): BatchCodeCrypto =>
      new CryptoBatchCodeCrypto(config.promotionsCodePepper),
  },
  {
    provide: FLASH_SALES,
    useFactory: (): FlashSales => new UnknownFlashSales(),
  },
  {
    provide: SELLER_ACTIVITY,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): SellerActivity => new FacadeSellerActivity(sellers),
  },
  {
    provide: PRICE_HISTORY,
    inject: [PRICING_FACADE],
    useFactory: (pricing: PricingFacade): PriceHistory => new FacadePriceHistory(pricing),
  },
  // Phase 3. The reads no module publishes yet are fail-closed adapters (see their file).
  {
    provide: CUSTOMER_ORDER_HISTORY,
    useFactory: (): CustomerOrderHistory => new UnknownCustomerOrderHistory(),
  },
  { provide: STORE_FOLLOWS, useFactory: (): StoreFollows => new UnknownStoreFollows() },
  {
    provide: DELIVERED_ORDER_FACTS,
    useFactory: (): DeliveredOrderFacts => new UnknownDeliveredOrderFacts(),
  },
  { provide: REFERRAL_SIGNALS, useFactory: (): ReferralSignals => new UnknownReferralSignals() },
  {
    provide: WALLET_CREDIT,
    inject: [WALLET_FACADE],
    useFactory: (wallet: WalletFacade): WalletCredit => new FacadeWalletCredit(wallet),
  },
  {
    provide: CREDIT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CreditRepository => new PrismaCreditRepository(prisma),
  },
  {
    provide: REFERRAL_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReferralRepository => new PrismaReferralRepository(prisma),
  },
];
