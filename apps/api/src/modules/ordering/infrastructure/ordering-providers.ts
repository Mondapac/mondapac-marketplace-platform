import type { FactoryProvider } from '@nestjs/common';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { CHECKOUT_GATEWAY, type CheckoutGateway } from '../application/ports/checkout-gateway';
import { ORDER_REPOSITORY, type OrderRepository } from '../application/ports/order.repository';
import { ORDERING_POLICY, type OrderingPolicy } from '../application/ports/ordering-policy';
import { ConfigOrderingPolicy } from './config-ordering-policy';
import { PrismaOrderRepository } from './prisma-order.repository';
import { StripeCheckoutGateway } from './stripe-checkout-gateway';

/** Binds the ports of ordering. Only this layer may reach `PrismaService` and the Stripe key. */
export const orderingProviders: readonly FactoryProvider[] = [
  {
    provide: ORDER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OrderRepository => new PrismaOrderRepository(prisma),
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
];
