import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MARKETING_CONSENT_REPOSITORY,
  type MarketingConsentRepository,
} from '../application/ports/marketing-consent.repository';
import { PrismaMarketingConsentRepository } from './prisma-marketing-consent.repository';

/** Binds the ports of legal. Only this layer may reach `PrismaService`. */
export const legalProviders: readonly FactoryProvider[] = [
  {
    provide: MARKETING_CONSENT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MarketingConsentRepository =>
      new PrismaMarketingConsentRepository(prisma),
  },
];
