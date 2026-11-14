import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { MAIL_TRANSPORT, type MailTransport } from '../../../platform/mail/mail-transport';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { ALERT_MESSENGER, type AlertMessenger } from '../application/ports/alert-messenger';
import { ON_CALL_ROSTER, type OnCallRosterSource } from '../application/ports/on-call-roster';
import {
  SECURITY_ALERT_REPOSITORY,
  type SecurityAlertRepository,
} from '../application/ports/security-alert.repository';
import { MailAlertMessenger } from './alert-messenger';
import { FileOnCallRoster } from './file-on-call-roster';
import { PrismaSecurityAlertRepository } from './prisma-security-alert.repository';

/** Binds the ports of security. Only this layer may reach `PrismaService` and the config. */
export const securityProviders: readonly FactoryProvider[] = [
  {
    provide: SECURITY_ALERT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SecurityAlertRepository =>
      new PrismaSecurityAlertRepository(prisma),
  },
  {
    provide: ON_CALL_ROSTER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): OnCallRosterSource =>
      new FileOnCallRoster(config.securityOnCallFile),
  },
  {
    provide: ALERT_MESSENGER,
    inject: [MAIL_TRANSPORT, MarketRegistry],
    useFactory: (mail: MailTransport, markets: MarketRegistry): AlertMessenger =>
      new MailAlertMessenger(mail, markets),
  },
];
