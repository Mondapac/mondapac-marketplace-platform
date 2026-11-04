import type { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditTrailReader } from '../../src/platform/audit/audit-trail-reader';
import { ChangeTrail } from '../../src/platform/audit/change-trail';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { FakeChangeActors } from '../support/change-trail-fakes';

/**
 * A real {@link ChangeTrail} on PostgreSQL: the module's own audit reader over the sealed
 * catalogue, with names from a fake identity (the names come from identity's own spec).
 */
export function dbChangeTrail(
  owner: string,
  catalogue: AuditActionCatalogue,
  unitOfWork: UnitOfWork,
  actors: FakeChangeActors = new FakeChangeActors(),
): ChangeTrail {
  const reader = PersistenceModule.auditTrailReaderFor(owner).useFactory(
    catalogue,
  ) as AuditTrailReader;
  return new ChangeTrail({ unitOfWork, reader, actors });
}
