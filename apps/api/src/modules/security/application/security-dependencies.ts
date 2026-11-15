import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { SecurityEventFeed } from '../../../platform/security-events/security-event-feed';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AlertMessenger } from './ports/alert-messenger';
import type { OnCallRosterSource } from './ports/on-call-roster';
import type { SecurityAlertRepository } from './ports/security-alert.repository';

/** What every security use case may need; one object built from the same ports. */
export interface SecurityDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly alerts: SecurityAlertRepository;
  readonly events: SecurityEventFeed;
  readonly roster: OnCallRosterSource;
  readonly messenger: AlertMessenger;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
