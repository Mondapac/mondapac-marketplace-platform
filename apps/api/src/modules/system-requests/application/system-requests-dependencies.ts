import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { SystemChangeReverters } from '../contracts/reverters';
import type { PolicyRepository } from './ports/policy.repository';
import type { RequestRepository } from './ports/request.repository';

/** What every system-requests use case may need; one object built from the same ports. */
export interface SystemRequestsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: RequestRepository;
  readonly policy: PolicyRepository;
  /** The modules' reverters, by subject kind (this module registers the review policy's own). */
  readonly reverters: SystemChangeReverters;
  /** Which area review keys the caller holds (row actions, decisions); never inside a unit. */
  readonly authorisation: AuthorisationCheck;
  /** Spends the admin step-up proof of a high-risk decision or a policy change, in its unit. */
  readonly stepUp: StepUpProofConsumer;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
