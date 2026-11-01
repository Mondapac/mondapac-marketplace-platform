import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ReviewsPolicy, ReviewsSettings } from '../application/ports/reviews-policy';

/** The Market's review settings from Market config; none configured means unavailable. */
export class ConfigReviewsPolicy implements ReviewsPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext): ReviewsSettings | null {
    const config = this.markets.get(market.marketId);
    const reviews = config.reviews;
    if (reviews === undefined) return null;
    return {
      reviewWindowDays: reviews.reviewWindowDays,
      editWindowDays: reviews.editWindowDays,
      sellerRatingMinCount: reviews.sellerRatingMinCount,
      maxSubmissionsPerAccountPerDay: reviews.maxSubmissionsPerAccountPerDay,
      maxHelpfulVotesPerAccountPerDay: reviews.maxHelpfulVotesPerAccountPerDay,
      titleMaxLength: reviews.titleMaxLength,
      bodyMaxLength: reviews.bodyMaxLength,
      pageSize: reviews.pageSize,
      defaultLocale: config.defaultLocale,
      supportedLocales: config.supportedLocales,
      textRules: {
        blockedTerms: reviews.autoChecks.blockedTerms,
        repeatedCharRun: reviews.autoChecks.repeatedCharRun,
        repeatedWordMinTokens: reviews.autoChecks.repeatedWordMinTokens,
        repeatedWordShareBps: reviews.autoChecks.repeatedWordShareBps,
      },
    };
  }
}
