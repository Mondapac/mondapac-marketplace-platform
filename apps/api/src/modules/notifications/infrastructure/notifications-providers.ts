import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  NOTIFICATIONS_POLICY,
  type NotificationsPolicy,
} from '../application/ports/notifications-policy';
import {
  SUPPORT_CONTACT_REPOSITORY,
  type SupportContactRepository,
} from '../application/ports/support-contact.repository';
import {
  NOTIFICATIONS_SECRET,
  UNSUBSCRIBE_TOKENS,
  type UnsubscribeTokens,
} from '../application/ports/unsubscribe-tokens';
import { ConfigNotificationsPolicy } from './config-notifications-policy';
import { HmacUnsubscribeTokens, localNotificationsSecret } from './hmac-unsubscribe-tokens';
import { PrismaSupportContactRepository } from './prisma-support-contact.repository';

/** Binds the ports of notifications. Only this layer may reach `PrismaService` and the secret. */
export const notificationsProviders: readonly FactoryProvider[] = [
  {
    provide: SUPPORT_CONTACT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SupportContactRepository =>
      new PrismaSupportContactRepository(prisma),
  },
  {
    provide: NOTIFICATIONS_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): NotificationsPolicy =>
      new ConfigNotificationsPolicy(markets),
  },
  {
    // The local stand-in of the notifications stack secret refuses production (K1).
    provide: NOTIFICATIONS_SECRET,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): Uint8Array => localNotificationsSecret(config),
  },
  {
    provide: UNSUBSCRIBE_TOKENS,
    inject: [NOTIFICATIONS_SECRET],
    useFactory: (secret: Uint8Array): UnsubscribeTokens => new HmacUnsubscribeTokens(secret),
  },
];
