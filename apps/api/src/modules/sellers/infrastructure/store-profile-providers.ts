import type { FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  STORE_IMAGE_PROCESSOR,
  type StoreImageProcessor,
} from '../application/ports/store-image-processor';
import {
  STORE_IMAGE_REPOSITORY,
  type StoreImageRepository,
} from '../application/ports/store-image.repository';
import {
  STORE_PROFILE_CONTENT_SEALER,
  type StoreProfileContentSealer,
} from '../application/ports/store-profile-content-sealer';
import {
  STORE_PROFILE_CONTENT_REPOSITORY,
  type StoreProfileContentRepository,
} from '../application/ports/store-profile-content.repository';
import {
  STORE_PROFILE_LOCALES_POLICY,
  type StoreProfileLocalesPolicy,
} from '../application/ports/store-profile-locales';
import { STORE_TEXT_CLAIM_CHECK } from '../application/ports/store-text-claim-check';
import { PublishedAboutCache } from '../application/store-profile/published-about-cache';
import {
  PUBLISHED_STORE_CONTENT,
  PublishedStoreContentReader,
} from '../application/store-profile/published-store-content';
import { LateBoundStoreTextClaimCheck } from './late-bound-store-text-claim-check';
import { MarketConfigStoreProfileLocales } from './market-config-store-profile-locales';
import { PrismaStoreImageRepository } from './prisma-store-image.repository';
import { PrismaStoreProfileContentRepository } from './prisma-store-profile-content.repository';
import { SharpStoreImageProcessor } from './sharp-store-image-processor';
import { SubjectKeyStoreProfileContentSealer } from './subject-key-store-profile-content-sealer';

/** The decrypted public About texts of this process (Hassan M5): one cache per process. */
const PUBLISHED_ABOUT_CACHE = Symbol('PUBLISHED_ABOUT_CACHE');

/**
 * Binds the ports of the store profile content (slice 12 part 2): the revisions and images
 * stores, the sealer, the Market's locales, the image processor, the public reader with its
 * bounded About cache, and the claim check that `SellerStoreProfileModule` binds to
 * certification after start (sellers cannot import certification without a module cycle).
 */
export const storeProfileProviders: readonly FactoryProvider[] = [
  {
    provide: STORE_PROFILE_CONTENT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): StoreProfileContentRepository =>
      new PrismaStoreProfileContentRepository(prisma),
  },
  {
    provide: STORE_IMAGE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): StoreImageRepository =>
      new PrismaStoreImageRepository(prisma),
  },
  {
    provide: STORE_PROFILE_CONTENT_SEALER,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (keys: SubjectKeyService): StoreProfileContentSealer =>
      new SubjectKeyStoreProfileContentSealer(keys),
  },
  {
    provide: STORE_PROFILE_LOCALES_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): StoreProfileLocalesPolicy =>
      new MarketConfigStoreProfileLocales(markets),
  },
  {
    provide: STORE_IMAGE_PROCESSOR,
    useFactory: (): StoreImageProcessor => new SharpStoreImageProcessor(),
  },
  {
    provide: STORE_TEXT_CLAIM_CHECK,
    useFactory: (): LateBoundStoreTextClaimCheck => new LateBoundStoreTextClaimCheck(),
  },
  {
    provide: PUBLISHED_ABOUT_CACHE,
    inject: [CLOCK],
    useFactory: (clock: Clock): PublishedAboutCache => new PublishedAboutCache(clock),
  },
  {
    provide: PUBLISHED_STORE_CONTENT,
    inject: [
      UNIT_OF_WORK,
      STORE_PROFILE_CONTENT_REPOSITORY,
      STORE_IMAGE_REPOSITORY,
      STORE_PROFILE_CONTENT_SEALER,
      STORE_PROFILE_LOCALES_POLICY,
      PUBLISHED_ABOUT_CACHE,
    ],
    useFactory: (
      unitOfWork: UnitOfWork,
      storeContent: StoreProfileContentRepository,
      storeImages: StoreImageRepository,
      contentSealer: StoreProfileContentSealer,
      localesPolicy: StoreProfileLocalesPolicy,
      aboutCache: PublishedAboutCache,
    ): PublishedStoreContentReader =>
      new PublishedStoreContentReader({
        unitOfWork,
        storeContent,
        storeImages,
        contentSealer,
        localesPolicy,
        aboutCache,
      }),
  },
];
