import type { Clock } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { SystemRequestRecorder } from '../../system-requests';
import type { MarketSettingRepository } from './ports/market-setting.repository';

/** What every settings use case may need; one object built from the same ports. */
export interface SettingsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly settings: MarketSettingRepository;
  readonly audit: AuditWriter;
  /** Opens the review of a change in the Market's marketplace area (Admin Inbox › System requests). */
  readonly review: SystemRequestRecorder;
  readonly clock: Clock;
}
