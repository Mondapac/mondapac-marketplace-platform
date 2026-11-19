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
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import { PUBLISHED_STORES, type PublishedStores } from '../application/ports/published-stores';
import {
  STORE_FOLLOW_REPOSITORY,
  type StoreFollowRepository,
} from '../application/ports/store-follow.repository';
import { FacadePublishedStores } from './facade-published-stores';
import { PrismaStoreFollowRepository } from './prisma-store-follow.repository';
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
    provide: STORE_FOLLOW_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): StoreFollowRepository =>
      new PrismaStoreFollowRepository(prisma),
  },
  {
    provide: PUBLISHED_STORES,
    inject: [SELLERS_FACADE],
    useFactory: (sellers: SellersFacade): PublishedStores => new FacadePublishedStores(sellers),
  },
  {
    provide: ENGAGEMENT_GUEST_TOKENS,
    useFactory: () => new CryptoEngagementGuestTokens(),
  },
];
