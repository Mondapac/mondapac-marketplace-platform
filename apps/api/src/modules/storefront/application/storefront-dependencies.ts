import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PageRepository } from './ports/page.repository';
import type { SlideRepository } from './ports/slide.repository';

/** What every storefront use case may need; one object built from the same ports. */
export interface StorefrontDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pages: PageRepository;
  readonly slides: SlideRepository;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
