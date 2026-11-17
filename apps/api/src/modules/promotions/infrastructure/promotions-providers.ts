import type { FactoryProvider } from '@nestjs/common';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { COMMISSION_PAYOUTS_FACADE, type CommissionPayoutsFacade } from '../../commission-payouts';
import { CUSTOMERS_READ_FACADE, type CustomersReadFacade } from '../../customers';
import { ENGAGEMENT_FACADE, type EngagementFacade } from '../../engagement';
import { ORDERING_FACADE, type OrderingFacade } from '../../ordering';
import { FacadeStoreFollows } from './facade-store-follows';
import {
  FacadeCustomerGroupMembership,
  FacadeExclusiveCustomers,
  FacadeCustomerOrderHistory,
} from './facade-customer-order-history';
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
  CUSTOMER_GROUP_MEMBERSHIP,
  EXCLUSIVE_CUSTOMERS,
  CUSTOMER_ORDER_HISTORY,
  STORE_FOLLOWS,
  type CustomerGroupMembership,
  type ExclusiveCustomers,
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
import { SELLER_CATALOGUE, type SellerCatalogue } from '../application/ports/seller-catalogue';
import { SELLER_COMMISSION, type SellerCommission } from '../application/ports/seller-commission';
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
import { UnknownReferralSignals } from './unknown-customer-facts';
import { FacadeDeliveredOrderFacts } from './facade-delivered-order-facts';
import { FacadeSellerCashbackLedger } from './facade-seller-cashback-ledger';
import {
  SELLER_CASHBACK_LEDGER,
  type SellerCashbackLedger,
} from '../application/ports/seller-cashback-ledger';
import { FacadeSellerCatalogue, FacadeSellerCommission } from './facade-seller-campaign-reads';
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
import { RedemptionFlashSales } from './redemption-flash-sales';
import { PrismaRedemptionRepository } from './prisma-redemption.repository';
import {
  REDEMPTION_REPOSITORY,
  type RedemptionRepository,
} from '../application/ports/redemption.repository';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';

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
    provide: REDEMPTION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RedemptionRepository =>
      new PrismaRedemptionRepository(prisma),
  },
  {
    provide: FLASH_SALES,
    inject: [UNIT_OF_WORK, REDEMPTION_REPOSITORY],
    useFactory: (units: UnitOfWork, redemptions: RedemptionRepository): FlashSales =>
      new RedemptionFlashSales(units, redemptions),
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
  {
    provide: SELLER_COMMISSION,
    inject: [COMMISSION_PAYOUTS_FACADE],
    useFactory: (payouts: CommissionPayoutsFacade): SellerCommission =>
      new FacadeSellerCommission(payouts),
  },
  {
    provide: SELLER_CATALOGUE,
    inject: [CATALOG_FACADE],
    useFactory: (catalog: CatalogFacade): SellerCatalogue => new FacadeSellerCatalogue(catalog),
  },
  // Phase 3. The last-order read is `customers`' facade (customers phase 1); the reads no module
  // publishes yet are fail-closed adapters; store follows are `engagement`'s facade (phase 3) (see their file).
  {
    provide: CUSTOMER_ORDER_HISTORY,
    inject: [CUSTOMERS_READ_FACADE],
    useFactory: (customers: CustomersReadFacade): CustomerOrderHistory =>
      new FacadeCustomerOrderHistory(customers),
  },
  {
    provide: CUSTOMER_GROUP_MEMBERSHIP,
    inject: [CUSTOMERS_READ_FACADE],
    useFactory: (customers: CustomersReadFacade): CustomerGroupMembership =>
      new FacadeCustomerGroupMembership(customers),
  },
  {
    provide: EXCLUSIVE_CUSTOMERS,
    inject: [CUSTOMERS_READ_FACADE],
    useFactory: (customers: CustomersReadFacade): ExclusiveCustomers =>
      new FacadeExclusiveCustomers(customers),
  },
  {
    provide: STORE_FOLLOWS,
    inject: [ENGAGEMENT_FACADE],
    useFactory: (engagement: EngagementFacade): StoreFollows => new FacadeStoreFollows(engagement),
  },
  {
    provide: DELIVERED_ORDER_FACTS,
    inject: [ORDERING_FACADE],
    useFactory: (ordering: OrderingFacade): DeliveredOrderFacts =>
      new FacadeDeliveredOrderFacts(ordering),
  },
  { provide: REFERRAL_SIGNALS, useFactory: (): ReferralSignals => new UnknownReferralSignals() },
  {
    provide: SELLER_CASHBACK_LEDGER,
    inject: [COMMISSION_PAYOUTS_FACADE],
    useFactory: (commission: CommissionPayoutsFacade): SellerCashbackLedger =>
      new FacadeSellerCashbackLedger(commission),
  },
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
