import type { Clock } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { ChangeTrail } from '../../../platform/audit/change-trail';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { NotificationsPolicy } from './ports/notifications-policy';
import type { SupportContactRepository } from './ports/support-contact.repository';

/** What every notifications use case may need; one object built from the same ports. */
export interface NotificationsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly contacts: SupportContactRepository;
  readonly policy: NotificationsPolicy;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  /** "Last changed by" and the history of the support contact, from this module's audit rows. */
  readonly trail: ChangeTrail;
}
