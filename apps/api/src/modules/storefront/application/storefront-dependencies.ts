import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PageRepository } from './ports/page.repository';
import type { LinkTargets } from './ports/link-targets';
import type { SlideRepository } from './ports/slide.repository';
import type { SlideTargets } from './ports/slide-targets';

/** What every storefront use case may need; one object built from the same ports. */
export interface StorefrontDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pages: PageRepository;
  readonly slides: SlideRepository;
  readonly targets: SlideTargets;
  /** Site paths of link targets (the category tree, the store address of a seller). */
  readonly links: LinkTargets;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
