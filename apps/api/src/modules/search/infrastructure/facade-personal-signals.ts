import { Logger } from '@nestjs/common';
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
  readonly #logger = new Logger('FacadePersonalSignals');

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
      if (result.ok) {
        return { productIds: result.value.productIds, categoryIds: result.value.categoryIds };
      }
      this.#warn('search.signals-refused', 'engagement.recent-views', context, result.error.code);
      return null;
    } catch (error) {
      this.#warn('search.signals-failed', 'engagement.recent-views', context, nameOf(error));
      return null;
    }
  }

  async certifiedCategoryIds(context: CallContext): Promise<ReadonlySet<Id<'Category'>> | null> {
    try {
      const result = await this.certification.certifiedCategoryIds(context);
      if (result.ok) return new Set(result.value);
      this.#warn(
        'search.signals-refused',
        'certification.certified-categories',
        context,
        result.error.code,
      );
      return null;
    } catch (error) {
      this.#warn(
        'search.signals-failed',
        'certification.certified-categories',
        context,
        nameOf(error),
      );
      return null;
    }
  }

  /** A code or an error name, the Market and the correlation id: never a message, id or token. */
  #warn(msg: string, source: string, context: CallContext, code: string): void {
    this.#logger.warn({
      msg,
      source,
      code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');
