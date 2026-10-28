import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { BlogMarketPolicy, BlogPolicy } from '../application/ports/blog-policy';

/** {@link BlogPolicy} over the Market config: `blog` plus the Market's own basics. */
export class ConfigBlogPolicy implements BlogPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  of(market: MarketContext): BlogMarketPolicy | null {
    const config = this.markets.get(market.marketId);
    const blog = config.blog;
    if (blog === undefined) return null;
    return {
      timeZone: config.timezone,
      currencyCode: config.defaultCurrency,
      defaultLocale: config.defaultLocale,
      supportedLocales: config.supportedLocales,
      sellerPostsPerMonth: blog.sellerPostsPerMonth,
      pageSize: blog.pageSize,
      defaultAuthorDisplay: blog.defaultAuthorDisplay,
      healthTerms: blog.healthTerms,
      selfApprovalWithStepUp: blog.selfApprovalWithStepUp,
    };
  }
}
