import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MARKET_SETTING_REPOSITORY,
  type MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import {
  CUSTOMER_REVIEWS_READER,
  type CustomerReviewsReader,
} from '../application/ports/customer-reviews.reader';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../application/ports/review.repository';
import { REVIEWER_NAMES, type ReviewerNames } from '../application/ports/reviewer-names';
import { REVIEWS_POLICY, type ReviewsPolicy } from '../application/ports/reviews-policy';
import { SELLER_AFFINITY, type SellerAffinity } from '../application/ports/seller-affinity';
import {
  SELLER_OVERLAP_SOURCE,
  type SellerOverlapSource,
} from '../application/ports/seller-overlap';
import { ConfigReviewsPolicy } from './config-reviews-policy';
import { PrismaCustomerReviewsReader } from './prisma-customer-reviews.reader';
import { PrismaMarketSettingRepository } from './prisma-market-setting.repository';
import { PrismaReviewRepository } from './prisma-review.repository';
import { UnavailableSellerOverlap } from './unavailable-seller-overlap';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { IdentitySellerAffinity } from './identity-seller-affinity';
import { UnavailableReviewerNames } from './unavailable-reviewer-names';
import {
  REVIEWS_WORK_QUEUE_COUNT_READER,
  type ReviewsWorkQueueCountReader,
} from '../application/ports/work-queue-count.reader';
import { PrismaReviewsWorkQueueCountReader } from './prisma-work-queue-count.reader';

/** Binds the ports of reviews. Only this layer may reach `PrismaService`. */
export const reviewsProviders: readonly FactoryProvider[] = [
  {
    provide: REVIEWS_WORK_QUEUE_COUNT_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReviewsWorkQueueCountReader =>
      new PrismaReviewsWorkQueueCountReader(prisma),
  },
  {
    provide: REVIEW_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReviewRepository => new PrismaReviewRepository(prisma),
  },
  {
    provide: CUSTOMER_REVIEWS_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): CustomerReviewsReader =>
      new PrismaCustomerReviewsReader(prisma),
  },
  {
    provide: MARKET_SETTING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MarketSettingRepository =>
      new PrismaMarketSettingRepository(prisma),
  },
  {
    provide: REVIEWS_POLICY,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): ReviewsPolicy => new ConfigReviewsPolicy(markets),
  },
  {
    provide: REVIEWER_NAMES,
    useFactory: (): ReviewerNames => new UnavailableReviewerNames(),
  },
  {
    provide: SELLER_AFFINITY,
    inject: [IDENTITY_FACADE],
    useFactory: (identity: IdentityFacade): SellerAffinity => new IdentitySellerAffinity(identity),
  },
  {
    provide: SELLER_OVERLAP_SOURCE,
    useFactory: (): SellerOverlapSource => new UnavailableSellerOverlap(),
  },
];
