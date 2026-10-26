import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  BEHAVIOUR_EVENT_REPOSITORY,
  type BehaviourEventRepository,
} from '../application/ports/behaviour-event.repository';
import { ENGAGEMENT_GUEST_TOKENS } from '../application/ports/guest-tokens';
import {
  PERSONALIZATION_SETTING_REPOSITORY,
  type PersonalizationSettingRepository,
} from '../application/ports/personalization-setting.repository';
import {
  BLOCK_COUNT_REPOSITORY,
  type BlockCountRepository,
} from '../application/ports/block-count.repository';
import { SERVED_PLACEMENTS, type ServedPlacements } from '../application/ports/served-placements';
import { STOREFRONT_FACADE, type StorefrontFacade } from '../../storefront';
import { CryptoEngagementGuestTokens } from './crypto-guest-tokens';
import { FacadeServedPlacements } from './facade-served-placements';
import { PrismaBlockCountRepository } from './prisma-block-count.repository';
import { PrismaBehaviourEventRepository } from './prisma-behaviour-event.repository';
import { PrismaPersonalizationSettingRepository } from './prisma-personalization-setting.repository';

/** Binds the ports of engagement. Only this layer may reach `PrismaService`. */
export const engagementProviders: readonly FactoryProvider[] = [
  {
    provide: BEHAVIOUR_EVENT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BehaviourEventRepository =>
      new PrismaBehaviourEventRepository(prisma),
  },
  {
    provide: PERSONALIZATION_SETTING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): PersonalizationSettingRepository =>
      new PrismaPersonalizationSettingRepository(prisma),
  },
  {
    provide: BLOCK_COUNT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): BlockCountRepository =>
      new PrismaBlockCountRepository(prisma),
  },
  {
    provide: SERVED_PLACEMENTS,
    inject: [STOREFRONT_FACADE],
    useFactory: (storefront: StorefrontFacade): ServedPlacements =>
      new FacadeServedPlacements(storefront),
  },
  {
    provide: ENGAGEMENT_GUEST_TOKENS,
    useFactory: () => new CryptoEngagementGuestTokens(),
  },
];
