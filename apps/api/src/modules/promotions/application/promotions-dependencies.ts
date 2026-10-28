import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { MarketSettingRepository } from './ports/market-setting.repository';
import type { OptInRepository } from './ports/opt-in.repository';
import type { PriceHistory } from './ports/price-history';
import type { PromotionRepository } from './ports/promotion.repository';
import type { PromotionsPolicy } from './ports/promotions-policy';
import type { ReviewQueueRepository } from './ports/review-queue.repository';
import type { SellerActivity } from './ports/seller-activity';
import type {
  FirstOrderSettingsRepository,
  ShippingThresholdRepository,
} from './ports/settings.repository';

/** What every promotions use case may need; one object built from the same ports. */
export interface PromotionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly promotions: PromotionRepository;
  readonly optIns: OptInRepository;
  readonly reviews: ReviewQueueRepository;
  readonly settings: MarketSettingRepository;
  readonly firstOrder: FirstOrderSettingsRepository;
  readonly thresholds: ShippingThresholdRepository;
  readonly policy: PromotionsPolicy;
  readonly sellerActivity: SellerActivity;
  readonly priceHistory: PriceHistory;
  /** Spends an admin's fresh two-step proof inside the use case's own unit. */
  readonly stepUp: StepUpProofConsumer;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
