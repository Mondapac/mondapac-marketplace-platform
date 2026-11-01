import { Logger, type FactoryProvider } from '@nestjs/common';
import { CATALOG_FACADE, type CatalogFacade } from '../../catalog';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { SHIPPING_FACADE, type ShippingFacade } from '../../shipping';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { SubjectRateLimits } from '../../../platform/rate-limit/subject-rate-limits';
import {
  PAYMENT_ATTEMPT_LIMITS,
  type PaymentAttemptLimits,
} from '../application/ports/payment-attempt-limits';
import { SubjectPaymentAttemptLimits } from './subject-payment-attempt-limits';
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
import {
  PICKUP_CODE_REPOSITORY,
  type PickupCodeRepository,
} from '../application/ports/pickup-code.repository';
import { PICKUP_CODE_VAULT, type PickupCodeVault } from '../application/ports/pickup-code-vault';
import { ConfigOrderingPolicy } from './config-ordering-policy';
import { FacadeOrderLabels } from './facade-order-labels';
import { FacadeOrderTaxCategories } from './facade-order-tax-categories';
import { ShippingDeliveryMethodPolicy } from './shipping-delivery-method-policy';
import { PrismaOrderRepository } from './prisma-order.repository';
import { PrismaPickupCodeRepository } from './prisma-pickup-code.repository';
import { PrismaRefundRepository } from './prisma-refund.repository';
import {
  SALES_RANKING_READER,
  type SalesRankingReader,
} from '../application/ports/sales-ranking.reader';
import { OFFER_PAIR_STORE, type OfferPairStore } from '../application/ports/offer-pairs.store';
import { PrismaOfferPairStore } from './prisma-offer-pairs.store';
import { PrismaSalesRankingReader } from './prisma-sales-ranking.reader';
import { StripeCheckoutGateway } from './stripe-checkout-gateway';
import { SubjectKeyPickupCodeVault } from './subject-key-pickup-code-vault';
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
    provide: PICKUP_CODE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PickupCodeRepository =>
      new PrismaPickupCodeRepository(prisma),
  },
  {
    provide: PICKUP_CODE_VAULT,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): PickupCodeVault => new SubjectKeyPickupCodeVault(keys),
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
    useFactory: (config: AppConfig): CheckoutGateway => {
      // A key without the card-only configuration opens no payment page (the gateway fails
      // closed); said once at boot so the cause is not a silent "unavailable" at checkout.
      if (config.stripeSecretKey !== null && config.stripePaymentMethodConfiguration === null) {
        new Logger('OrderingProviders').warn(
          'STRIPE_SECRET_KEY is set without STRIPE_PAYMENT_METHOD_CONFIGURATION: checkout answers unavailable',
        );
      }
      return new StripeCheckoutGateway(
        config.stripeSecretKey,
        config.stripePaymentMethodConfiguration,
      );
    },
  },
  {
    provide: PAYMENT_ATTEMPT_LIMITS,
    inject: [SubjectRateLimits],
    useFactory: (counters: SubjectRateLimits): PaymentAttemptLimits =>
      new SubjectPaymentAttemptLimits(counters),
  },
  {
    provide: ORDERING_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): OrderingPolicy => new ConfigOrderingPolicy(markets),
  },
  {
    provide: DELIVERY_METHOD_POLICY,
    inject: [SHIPPING_FACADE],
    useFactory: (shipping: ShippingFacade): DeliveryMethodPolicy =>
      new ShippingDeliveryMethodPolicy(shipping),
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
