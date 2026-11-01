import type { Clock } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { MarketSettingRepository } from './ports/market-setting.repository';

/** What every settings use case may need; one object built from the same ports. */
export interface SettingsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly settings: MarketSettingRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}
