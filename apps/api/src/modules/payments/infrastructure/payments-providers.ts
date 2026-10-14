import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { STRIPE_EVENT_INBOX, type StripeEventInbox } from '../application/ports/stripe-event-inbox';
import {
  STRIPE_SESSION_READER,
  type StripeSessionReader,
} from '../application/ports/stripe-session-reader';
import { STRIPE_SIGNATURE, type StripeSignature } from '../application/ports/stripe-signature';
import { PrismaStripeEventInbox } from './prisma-stripe-event-inbox';
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
      new StripeWebhookSignature(config.stripeWebhookSecret, clock),
  },
  {
    provide: STRIPE_SESSION_READER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): StripeSessionReader =>
      new StripeCheckoutSessionReader(config.stripeSecretKey),
  },
];
