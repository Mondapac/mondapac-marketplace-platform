import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CertificationFacade } from '../../certification';
import type { EngagementFacade } from '../../engagement';
import type {
  PersonalSignals,
  PersonalViews,
  PrivacySignals,
} from '../application/ports/personal-signals';

/**
 * {@link PersonalSignals} over engagement's `recentViews` and certification's
 * `certifiedCategoryIds`, both called with the request's context unchanged. Any refusal, failure
 * or exception is `null`: the caller fails closed (no personal signal is used).
 */
export class FacadePersonalSignals implements PersonalSignals {
  constructor(
    private readonly engagement: EngagementFacade,
    private readonly certification: CertificationFacade,
  ) {}

  async recentViews(context: CallContext, privacy: PrivacySignals): Promise<PersonalViews | null> {
    try {
      const result = await this.engagement.recentViews(context, {
        globalPrivacyControl: privacy.globalPrivacyControl,
        consent: privacy.consent,
        guestToken: privacy.guestToken,
      });
      return result.ok
        ? { productIds: result.value.productIds, categoryIds: result.value.categoryIds }
        : null;
    } catch {
      return null;
    }
  }

  async certifiedCategoryIds(context: CallContext): Promise<ReadonlySet<Id<'Category'>> | null> {
    try {
      const result = await this.certification.certifiedCategoryIds(context);
      return result.ok ? new Set(result.value) : null;
    } catch {
      return null;
    }
  }
}
