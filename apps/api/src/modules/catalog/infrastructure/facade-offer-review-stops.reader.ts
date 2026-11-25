import type { CallContext } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SettingsFacade } from '../../settings';
import type { OfferReviewStopsReader } from '../application/ports/offer-review-stops.reader';

/**
 * {@link OfferReviewStopsReader} on the settings facade (`offerReviewPolicy`) and the sellers
 * facade (`offerReviewStoppedSellerCount`). A refusal, an error or a throw is null: the banner
 * shows what it can and never invents a stop.
 */
export class FacadeOfferReviewStopsReader implements OfferReviewStopsReader {
  constructor(
    private readonly settings: SettingsFacade,
    private readonly sellers: SellersFacade,
  ) {}

  async marketStop(context: CallContext): Promise<boolean | null> {
    try {
      const policy = await this.settings.offerReviewPolicy(context);
      return typeof policy.emergencyStop === 'boolean' ? policy.emergencyStop : null;
    } catch {
      return null;
    }
  }

  async stoppedSellerCount(context: CallContext): Promise<number | null> {
    try {
      const answer = await this.sellers.offerReviewStoppedSellerCount(context);
      return answer.ok ? answer.value : null;
    } catch {
      return null;
    }
  }
}
