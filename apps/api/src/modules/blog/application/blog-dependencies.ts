import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { BlogLinks } from './ports/blog-links';
import type { BlogPolicy } from './ports/blog-policy';
import type { BlogRepository } from './ports/blog.repository';

/** What every blog use case may need; one object built from the same ports. */
export interface BlogDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly posts: BlogRepository;
  readonly policy: BlogPolicy;
  readonly links: BlogLinks;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
