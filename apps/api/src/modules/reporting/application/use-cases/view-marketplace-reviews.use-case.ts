import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import { REVIEWS_SETTINGS_VIEW } from '../../../reviews';
import { marketDayOf } from '../../domain/facts';
import { marketReviewsOf, type MarketReviews } from '../../domain/reviews';
import { resolvePeriod, windowOf, type ResolvedPeriod } from '../../domain/period';
import type { KpiFailure } from '../admin-kpi-flow';
import type { MarketZone } from '../ports/market-zone';
import type { ReviewSources } from '../ports/review-sources';

const logger = new Logger('ViewMarketplaceReviews');

export interface MarketplaceReviewsDependencies {
  readonly sources: ReviewSources;
  readonly zone: MarketZone;
  readonly clock: Clock;
}

export interface MarketplaceReviewsAnswer {
  /** Always the last 30 Market days (today included) against the 30 before. */
  readonly period: ResolvedPeriod;
  readonly generatedAt: Temporal.Instant;
  readonly reviews: MarketReviews;
}

/**
 * `reporting.view-marketplace-reviews` (dashboards v2, phase 2): the reviews the Market published
 * in the last 30 Market days against the 30 before, as counts from the reviews module (how many,
 * the average, how many of each rating, the share of 1 and 2 stars). Fixed to 30 days, whatever
 * period the dashboard shows. Key `reviews.settings.view` (protected: only the Platform
 * Administrator), a platform admin acting as themselves. Reviews off in the Market is its own
 * `off` answer; below five reviews there are no numbers.
 */
export class ViewMarketplaceReviews extends UseCase<
  Record<string, never>,
  MarketplaceReviewsAnswer,
  KpiFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.view-marketplace-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MarketplaceReviewsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<MarketplaceReviewsAnswer, KpiFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const now = this.deps.clock.now();
    const zone = this.deps.zone.zoneOf(context.market);
    const period = resolvePeriod('30d', marketDayOf(now, zone));
    const counts = await this.deps.sources.countsOf(context, [
      windowOf(period.current, zone),
      windowOf(period.previous, zone),
    ]);
    if (!counts.ok) {
      if (counts.error.code === 'reviews.disabled') {
        return ok({ period, generatedAt: now, reviews: { status: 'off' } });
      }
      if (counts.error.code === 'access.denied') return err({ code: 'access.denied' });
      logger.warn({
        msg: 'reporting.reviews.read-failed',
        outcome: counts.error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    const [current, previous] = counts.value;
    return ok({ period, generatedAt: now, reviews: marketReviewsOf(current!, previous!) });
  }
}
