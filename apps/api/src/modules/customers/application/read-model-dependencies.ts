import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CustomerReadModelPeers } from './ports/customer-read-model-peers';
import type { CustomerReadModelRepository } from './ports/customer-read-models.repository';

/** What the customers read model use cases need. */
export interface ReadModelDependencies extends CustomerReadModelPeers {
  readonly unitOfWork: UnitOfWork;
  readonly readModels: CustomerReadModelRepository;
  readonly clock: Clock;
}
