import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  CONNECTED_ACCOUNT_STORE,
  type ConnectedAccountStore,
} from '../application/ports/connected-account-store';
import { CONNECT_GATEWAY, type ConnectGateway } from '../application/ports/connect-gateway';
import { DISPUTE_STORE, type DisputeStore } from '../application/ports/dispute-store';
import { PAYMENTS_POLICY, type PaymentsPolicy } from '../application/ports/payments-policy';
import {
  STRIPE_DISPUTE_READER,
  type StripeDisputeReader,
} from '../application/ports/stripe-dispute-reader';
import { STRIPE_EVENT_INBOX, type StripeEventInbox } from '../application/ports/stripe-event-inbox';
import {
  STRIPE_SESSION_READER,
  type StripeSessionReader,
} from '../application/ports/stripe-session-reader';
import { STRIPE_SIGNATURE, type StripeSignature } from '../application/ports/stripe-signature';
import { ConfigPaymentsPolicy } from './config-payments-policy';
import { PrismaConnectedAccountStore } from './prisma-connected-account-store';
import { PrismaDisputeStore } from './prisma-dispute-store';
import { PrismaStripeEventInbox } from './prisma-stripe-event-inbox';
import { StripeConnectGateway } from './stripe-connect-gateway';
import { StripeDisputeApiReader } from './stripe-dispute-reader';
import { StripeCheckoutSessionReader } from './stripe-session-reader';
import { StripeWebhookSignature } from './stripe-webhook-signature';

/** Binds the ports of payments. Only this layer may reach `PrismaService` and the Stripe secrets. */
export const paymentsProviders: readonly FactoryProvider[] = [
  {
    provide: STRIPE_EVENT_INBOX,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): StripeEventInbox => new PrismaStripeEventInbox(prisma),
  },
  {
    provide: STRIPE_SIGNATURE,
    inject: [APP_CONFIG, CLOCK],
    useFactory: (config: AppConfig, clock: Clock): StripeSignature =>
      new StripeWebhookSignature(
        config.stripeWebhookSecrets,
        clock,
        config.stripeConnectWebhookSecrets,
      ),
  },
  {
    provide: STRIPE_SESSION_READER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): StripeSessionReader =>
      new StripeCheckoutSessionReader(config.stripeSecretKey),
  },
  {
    provide: STRIPE_DISPUTE_READER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): StripeDisputeReader =>
      new StripeDisputeApiReader(config.stripeSecretKey),
  },
  {
    provide: DISPUTE_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): DisputeStore => new PrismaDisputeStore(prisma),
  },
  {
    provide: CONNECTED_ACCOUNT_STORE,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ConnectedAccountStore =>
      new PrismaConnectedAccountStore(prisma),
  },
  {
    provide: CONNECT_GATEWAY,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): ConnectGateway =>
      new StripeConnectGateway(config.stripeSecretKey),
  },
  {
    provide: PAYMENTS_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): PaymentsPolicy => new ConfigPaymentsPolicy(markets),
  },
];
