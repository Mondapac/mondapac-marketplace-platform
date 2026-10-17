import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { StrategyRepository } from './ports/strategy.repository';
import type { TaxPolicy } from './ports/tax-policy';

/** What every tax use case may need; one object built from the same ports. */
export interface TaxDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly strategies: StrategyRepository;
  readonly policy: TaxPolicy;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
