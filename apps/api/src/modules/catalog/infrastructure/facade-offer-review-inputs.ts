import type { CallContext, Id } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { SettingsFacade } from '../../settings';
import type { CategoryOfferReviewFlagsStore } from '../application/ports/category-offer-review-flags.store';
import type { CategoryPathsReader } from '../application/ports/category-paths.reader';
import type { OfferPostReviewRepository } from '../application/ports/offer-post-review';
import {
  SAFE_OFFER_REVIEW_SETTINGS,
  type OfferReviewFactsRead,
  type OfferReviewInputs,
  type OfferReviewSettings,
} from '../application/ports/offer-review';
import type { SellerOfferReviewFlagsReader } from '../application/ports/seller-offer-review-flags.reader';
import type { SellerReviewStandingRepository } from '../application/ports/seller-review-standing.repository';
import { categoryReviewFactsOf } from '../domain/category-offer-review-flags';
import { samplingPercentOf } from '../domain/offer-post-review';
import {
  probationOffersOf,
  SAFE_PROBATION_OFFERS,
  stampsTrust,
  trustStatusOf,
  type StandingFacts,
} from '../domain/seller-review-standing';

export interface FacadeOfferReviewInputsDependencies {
  readonly settings: SettingsFacade;
  readonly sellerFlags: SellerOfferReviewFlagsReader;
  readonly unitOfWork: UnitOfWork;
  readonly standings: SellerReviewStandingRepository;
  readonly categoryFlags: CategoryOfferReviewFlagsStore;
  readonly categoryPaths: CategoryPathsReader;
  /** The post-publication review rows (slice 6): whether the Offer was ever taken down. */
  readonly postReviews: OfferPostReviewRepository;
}

const FAILED = Symbol('failed');

/**
 * {@link OfferReviewInputs} (ADR-0051; slice 4): the Market's settings on the settings facade, and
 * the facts of one seller and product from the sellers facade (`offerReviewFlagsOf`), the
 * seller's standing and the product's categories, each read outside the decision's unit (in
 * read-only units of their own). Fail closed, piece by piece, never throwing:
 *
 * - the settings: the safe answer (mode `all`); N unreadable or out of bounds: the safe 100;
 * - the sellers facade refused, the seller is unknown or it failed: probation and full review on;
 * - the standing cannot be read: probation on;
 * - the categories cannot be read: sensitive category on;
 * - whether the Offer was ever taken down after publication (slice 6) cannot be read: full review
 *   on (an Offer that was taken down always gets R6 on its resubmit);
 *
 * each of the last four with `degraded`. A stop is never invented: the seller's stop counts only
 * when the facade answered, the category stop only when the categories were read.
 */
export class FacadeOfferReviewInputs implements OfferReviewInputs {
  constructor(private readonly deps: FacadeOfferReviewInputsDependencies) {}

  async settings(context: CallContext): Promise<OfferReviewSettings> {
    try {
      const policy = await this.deps.settings.offerReviewPolicy(context);
      const mode =
        policy.mode === 'risk-based' || policy.mode === 'off' || policy.mode === 'all'
          ? policy.mode
          : SAFE_OFFER_REVIEW_SETTINGS.mode;
      const certificateBadges =
        policy.certificateBadges === 'automatic' ? 'automatic' : ('review' as const);
      return {
        mode,
        certificateBadges,
        emergencyStop: policy.emergencyStop === true,
        // Out of bounds or not a whole number: the safe 100 (slice 6).
        samplingPercent: samplingPercentOf(policy.samplingPercent),
      };
    } catch {
      return SAFE_OFFER_REVIEW_SETTINGS;
    }
  }

  async probationOffers(context: CallContext): Promise<number> {
    try {
      const policy = await this.deps.settings.offerReviewPolicy(context);
      return typeof policy.probationOffers === 'number'
        ? probationOffersOf(policy.probationOffers)
        : SAFE_PROBATION_OFFERS;
    } catch {
      return SAFE_PROBATION_OFFERS;
    }
  }

  async facts(
    context: CallContext,
    subject: {
      readonly sellerId: Id<'Seller'>;
      readonly productId: Id<'Product'>;
      readonly offerId?: Id<'Offer'>;
    },
  ): Promise<OfferReviewFactsRead> {
    const [probationOffers, flags, standing, categories, takenDown] = await Promise.all([
      this.probationOffers(context),
      this.deps.sellerFlags.flagsOf(context, subject.sellerId).catch(() => null),
      this.#standing(context, subject.sellerId),
      this.#categories(context, subject.productId),
      subject.offerId === undefined ? false : this.#everTakenDown(context, subject.offerId),
    ]);
    const flagsFailed = flags === null;
    const standingFailed = standing === FAILED;
    const categoriesFailed = categories === FAILED;
    const takenDownFailed = takenDown === FAILED;
    const trust =
      flagsFailed || standingFailed
        ? null
        : trustStatusOf(standing, { trustedFromStart: flags.trustedFromStart }, probationOffers);
    return {
      // R0: only a stop that was read; a failure never invents one.
      emergencyStop:
        flags?.reviewStop.on === true || (!categoriesFailed && categories.emergencyStop),
      probation: trust === null || trust.status === 'probation',
      // R6 also for an Offer that was ever taken down after publication (slice 6): its resubmit
      // gets a full review; a failed read of that is R6 as well.
      fullReview: flagsFailed || flags.fullReview.on || takenDown !== false,
      sensitiveCategory: categoriesFailed || categories.sensitiveCategory,
      degraded: flagsFailed || standingFailed || categoriesFailed || takenDownFailed,
      stampTrust:
        !standingFailed &&
        standing !== null &&
        standing.trustedAt === null &&
        trust !== null &&
        trust.status === 'trusted' &&
        trust.source === 'count' &&
        stampsTrust(trust.count, trust.target),
      probationOffers,
      trustedSince: trust?.trustedSince ?? null,
    };
  }

  /** Whether the Offer was ever taken down after publication; FAILED on any error. */
  async #everTakenDown(
    context: CallContext,
    offerId: Id<'Offer'>,
  ): Promise<boolean | typeof FAILED> {
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.postReviews.everTakenDown(market, offerId)),
        { readOnly: true },
      );
      return read.ok ? read.value : FAILED;
    } catch {
      return FAILED;
    }
  }

  /** The standing and its count, null when the seller has none yet, FAILED on any error. */
  async #standing(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<StandingFacts | null | typeof FAILED> {
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.standings.read(market, sellerId)),
        { readOnly: true },
      );
      if (!read.ok) return FAILED;
      return read.value === null ? null : { ...read.value.state, count: read.value.count };
    } catch {
      return FAILED;
    }
  }

  /**
   * R7 and the category stop of the product: its published revision's categories and their
   * ancestors (merges followed) against the Market's few flagged categories. FAILED on any error,
   * including a tree that cannot be walked.
   */
  async #categories(
    context: CallContext,
    productId: Id<'Product'>,
  ): Promise<
    { readonly sensitiveCategory: boolean; readonly emergencyStop: boolean } | typeof FAILED
  > {
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => {
          const flagged = await this.deps.categoryFlags.listFlagged(market);
          if (flagged.length === 0) return ok({ sensitiveCategory: false, emergencyStop: false });
          const named = await this.deps.categoryFlags.publishedCategoryIds(market, productId);
          const paths = await this.deps.categoryPaths.livePaths(market, named);
          // The named categories count too, also one the live paths drop (an archived one).
          const ids = new Set<string>([...named, ...paths.flat()]);
          return ok(categoryReviewFactsOf(ids, flagged));
        },
        { readOnly: true },
      );
      return read.ok ? read.value : FAILED;
    } catch {
      return FAILED;
    }
  }
}
