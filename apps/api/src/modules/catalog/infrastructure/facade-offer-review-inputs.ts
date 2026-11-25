import type { CallContext } from '@mondapac/shared-kernel';
import type { SettingsFacade } from '../../settings';
import {
  SAFE_OFFER_REVIEW_SETTINGS,
  type OfferReviewInputs,
  type OfferReviewSettings,
} from '../application/ports/offer-review';
import type { OfferReviewFacts } from '../domain/offer-review-policy';

/**
 * Until the probation counter and the seller flags exist, every seller counts as in probation, so
 * in risk-based mode every new Offer still goes to an admin (fail closed). The emergency stop, the
 * full-review flag and the "always review" categories have no source yet and are off.
 */
const FACTS_BEFORE_PROBATION: OfferReviewFacts = Object.freeze({
  emergencyStop: false,
  probation: true,
  fullReview: false,
  sensitiveCategory: false,
});

/**
 * {@link OfferReviewInputs} on the settings facade (ADR-0051). A throw or an unknown value is the
 * safe answer: review everything.
 */
export class FacadeOfferReviewInputs implements OfferReviewInputs {
  constructor(private readonly facade: SettingsFacade) {}

  async settings(context: CallContext): Promise<OfferReviewSettings> {
    try {
      const policy = await this.facade.offerReviewPolicy(context);
      const mode =
        policy.mode === 'risk-based' || policy.mode === 'off' || policy.mode === 'all'
          ? policy.mode
          : SAFE_OFFER_REVIEW_SETTINGS.mode;
      const certificateBadges =
        policy.certificateBadges === 'automatic' ? 'automatic' : ('review' as const);
      return { mode, certificateBadges, emergencyStop: policy.emergencyStop === true };
    } catch {
      return SAFE_OFFER_REVIEW_SETTINGS;
    }
  }

  facts(): Promise<OfferReviewFacts> {
    return Promise.resolve(FACTS_BEFORE_PROBATION);
  }
}
