import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market settings the blog reads (Market config `blog`, plus the Market's own basics). */
export interface BlogMarketPolicy {
  readonly timeZone: string;
  readonly currencyCode: string;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly sellerPostsPerMonth: number;
  readonly pageSize: number;
  readonly defaultAuthorDisplay: string;
  readonly healthTerms: readonly string[];
  /** The Market's content filter terms (Market config `contentFilter`); none when not set. */
  readonly blockedTerms: readonly string[];
  readonly selfApprovalWithStepUp: boolean;
}

export interface BlogPolicy {
  /** Null when the Market has no `blog` section: the blog is unavailable there (fail closed). */
  of(market: MarketContext): BlogMarketPolicy | null;
}

export const BLOG_POLICY = Symbol('BLOG_POLICY');
