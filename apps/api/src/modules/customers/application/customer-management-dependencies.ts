import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AdminDayZone } from './ports/admin-day-zone';
import type { CustomerGroupRepository } from './ports/customer-groups.repository';
import type { CustomerListReader } from './ports/customer-list.reader';
import type { IdentityManagementPeer } from './ports/customer-management-peers';
import type { CustomerNoteCipher, CustomerNoteRepository } from './ports/customer-notes.repository';
import type { CustomerTimelineRepository } from './ports/customer-timeline.repository';
import type { SheetWriter } from './ports/sheet-writer';

/**
 * What the admin's management of customers (phase 2, PR 2a: groups, notes, the timeline and the
 * name edit) needs; one object built from the same ports for every such use case.
 */
export interface CustomerManagementDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly groups: CustomerGroupRepository;
  readonly notes: CustomerNoteRepository;
  readonly noteCipher: CustomerNoteCipher;
  readonly timeline: CustomerTimelineRepository;
  readonly listReader: CustomerListReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Spends the admin step-up proof of a timeline export inside its unit. */
  readonly stepUp: StepUpProofConsumer;
  readonly sheetWriter: SheetWriter;
  /** The zone the day filters of the timeline and of "select all matching" are read in. */
  readonly dayZone: AdminDayZone;
  /** Bound at start by `CustomersReadModelsModule`; fails closed until then. */
  readonly identity: IdentityManagementPeer;
}
