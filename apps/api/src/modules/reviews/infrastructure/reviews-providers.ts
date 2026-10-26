import type { FactoryProvider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MARKET_SETTING_REPOSITORY,
  type MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../application/ports/review.repository';
import { REVIEWER_NAMES, type ReviewerNames } from '../application/ports/reviewer-names';
import { REVIEWS_POLICY, type ReviewsPolicy } from '../application/ports/reviews-policy';
import { SELLER_AFFINITY, type SellerAffinity } from '../application/ports/seller-affinity';
import { ConfigReviewsPolicy } from './config-reviews-policy';
import { PrismaMarketSettingRepository } from './prisma-market-setting.repository';
import { PrismaReviewRepository } from './prisma-review.repository';
import { StructuralSellerAffinity } from './structural-seller-affinity';
import { UnavailableReviewerNames } from './unavailable-reviewer-names';

/** Binds the ports of reviews. Only this layer may reach `PrismaService`. */
export const reviewsProviders: readonly FactoryProvider[] = [
  {
    provide: REVIEW_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReviewRepository => new PrismaReviewRepository(prisma),
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
    useFactory: (): SellerAffinity => new StructuralSellerAffinity(),
  },
];
