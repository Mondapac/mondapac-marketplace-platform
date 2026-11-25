import type { CallContext } from '@mondapac/shared-kernel';
import type { ReadAiDescriptionWriter } from '../application/use-cases/read-ai-description-writer.use-case';
import type { ReadCartMode } from '../application/use-cases/read-cart-mode.use-case';
import type { ReadOfferQueueBacklogLimits } from '../application/use-cases/read-offer-queue-backlog-limits.use-case';
import type { ReadMonthlyRevenueTarget } from '../application/use-cases/read-monthly-revenue-target.use-case';
import {
  SAFE_OFFER_REVIEW_POLICY,
  type ReadOfferReviewPolicy,
} from '../application/use-cases/read-offer-review-policy.use-case';
import type { SettingsFacade } from '../contracts/settings.facade';

/** {@link SettingsFacade} on the settings use cases; a refusal or a throw is off (or
 * `multi-store` for the Cart mode). */
export class SettingsFacadeImplementation implements SettingsFacade {
  constructor(
    private readonly readAiDescriptionWriter: ReadAiDescriptionWriter,
    private readonly readCartMode: ReadCartMode,
    private readonly readMonthlyRevenueTarget: ReadMonthlyRevenueTarget,
    private readonly readOfferReviewPolicy?: ReadOfferReviewPolicy,
    private readonly readBacklogLimits?: ReadOfferQueueBacklogLimits,
  ) {}

  monthlyRevenueTarget(context: CallContext) {
    return this.readMonthlyRevenueTarget.execute(context, {});
  }

  async offerReviewPolicy(context: CallContext) {
    try {
      const answer = await this.readOfferReviewPolicy?.execute(context, {});
      if (answer?.ok) return answer.value;
    } catch {
      // The safe policy below.
    }
    return SAFE_OFFER_REVIEW_POLICY;
  }

  async aiDescriptionWriter(context: CallContext) {
    try {
      const answer = await this.readAiDescriptionWriter.execute(context, {});
      if (answer.ok) return answer.value;
    } catch {
      // Fail closed below.
    }
    return { enabled: false, tier: 'fast' as const };
  }

  async cartMode(context: CallContext) {
    try {
      const answer = await this.readCartMode.execute(context, {});
      if (answer.ok) return answer.value;
    } catch {
      // The safe value below.
    }
    return 'multi-store' as const;
  }

  async offerQueueBacklogLimits(context: CallContext) {
    try {
      const answer = await this.readBacklogLimits?.execute(context, {});
      if (answer?.ok) return answer.value;
    } catch {
      // Null below.
    }
    return null;
  }
}
