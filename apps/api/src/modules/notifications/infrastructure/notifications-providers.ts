import type { FactoryProvider } from '@nestjs/common';
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
import { ConfigNotificationsPolicy } from './config-notifications-policy';
import { PrismaSupportContactRepository } from './prisma-support-contact.repository';

/** Binds the ports of notifications. Only this layer may reach `PrismaService`. */
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
];
