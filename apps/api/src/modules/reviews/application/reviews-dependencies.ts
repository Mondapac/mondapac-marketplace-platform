import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CatalogFacade } from '../../catalog';
import type { OrderingFacade } from '../../ordering';
import type { MarketSettingRepository } from './ports/market-setting.repository';
import type { ReviewRepository } from './ports/review.repository';
import type { ReviewerNames } from './ports/reviewer-names';
import type { ReviewsPolicy } from './ports/reviews-policy';
import type { SellerAffinity } from './ports/seller-affinity';

/** What every reviews use case may need; one object built from the same ports. */
export interface ReviewsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reviews: ReviewRepository;
  readonly settings: MarketSettingRepository;
  readonly policy: ReviewsPolicy;
  /** Eligibility is asked of ordering at write time; nothing of it is copied here. */
  readonly ordering: OrderingFacade;
  /** Offer to product, when an order line has only the offer. */
  readonly catalog: CatalogFacade;
  readonly names: ReviewerNames;
  readonly affinity: SellerAffinity;
  readonly audit: AuditWriter;
  /** Spends an admin's two-step proof once, inside the unit that makes the change (ADR-0018). */
  readonly stepUp: StepUpProofConsumer;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
