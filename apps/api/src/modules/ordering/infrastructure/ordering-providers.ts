import type { FactoryProvider } from '@nestjs/common';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { CHECKOUT_GATEWAY, type CheckoutGateway } from '../application/ports/checkout-gateway';
import { ORDER_LABELS, type OrderLabels } from '../application/ports/order-labels';
import {
  ORDER_TAX_CATEGORIES,
  type OrderTaxCategories,
} from '../application/ports/order-tax-categories';
import { ORDER_REPOSITORY, type OrderRepository } from '../application/ports/order.repository';
import { ORDERING_POLICY, type OrderingPolicy } from '../application/ports/ordering-policy';
import { REFUND_REPOSITORY, type RefundRepository } from '../application/ports/refund.repository';
import { SHIP_TO_CIPHER, type ShipToCipher } from '../application/ports/ship-to-cipher';
import {
  DELIVERY_METHOD_POLICY,
  type DeliveryMethodPolicy,
} from '../application/ports/delivery-method-policy';
import { AllowAllDeliveryMethods } from './allow-all-delivery-methods';
import { ConfigOrderingPolicy } from './config-ordering-policy';
import { FacadeOrderLabels } from './facade-order-labels';
import { FacadeOrderTaxCategories } from './facade-order-tax-categories';
import { PrismaOrderRepository } from './prisma-order.repository';
import { PrismaRefundRepository } from './prisma-refund.repository';
import {
  SALES_RANKING_READER,
  type SalesRankingReader,
} from '../application/ports/sales-ranking.reader';
import { OFFER_PAIR_STORE, type OfferPairStore } from '../application/ports/offer-pairs.store';
import { PrismaOfferPairStore } from './prisma-offer-pairs.store';
import { PrismaSalesRankingReader } from './prisma-sales-ranking.reader';
import { StripeCheckoutGateway } from './stripe-checkout-gateway';
import { SubjectKeyShipToCipher } from './subject-key-ship-to-cipher';

/**
 * Binds the ports of ordering. Only this layer may reach `PrismaService`, subject keys and the
 * Stripe key.
 */
export const orderingProviders: readonly FactoryProvider[] = [
  {
    provide: ORDER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OrderRepository => new PrismaOrderRepository(prisma),
  },
  {
    provide: REFUND_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): RefundRepository => new PrismaRefundRepository(prisma),
  },
  {
    provide: SHIP_TO_CIPHER,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): ShipToCipher => new SubjectKeyShipToCipher(keys),
  },
  {
    provide: SALES_RANKING_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SalesRankingReader => new PrismaSalesRankingReader(prisma),
  },
  {
    provide: OFFER_PAIR_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OfferPairStore => new PrismaOfferPairStore(prisma),
  },
  {
    provide: CHECKOUT_GATEWAY,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): CheckoutGateway =>
      new StripeCheckoutGateway(config.stripeSecretKey),
  },
  {
    provide: ORDERING_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): OrderingPolicy => new ConfigOrderingPolicy(markets),
  },
  {
    provide: DELIVERY_METHOD_POLICY,
    useFactory: (): DeliveryMethodPolicy => new AllowAllDeliveryMethods(),
  },
  {
    provide: ORDER_TAX_CATEGORIES,
    inject: [CATALOG_FACADE],
    useFactory: (catalog: CatalogFacade): OrderTaxCategories =>
      new FacadeOrderTaxCategories(catalog),
  },
  {
    provide: ORDER_LABELS,
    inject: [CATALOG_FACADE, SELLERS_FACADE, IDENTITY_FACADE, MarketRegistry],
    useFactory: (
      catalog: CatalogFacade,
      sellers: SellersFacade,
      identity: IdentityFacade,
      markets: MarketRegistry,
    ): OrderLabels => new FacadeOrderLabels(catalog, sellers, identity, markets),
  },
];
