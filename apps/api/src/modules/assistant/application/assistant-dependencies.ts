import type { Clock } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AssistantRuntime } from './ports/assistant-runtime';
import type { AssistantSettingsRepository } from './ports/assistant-settings.repository';

/** What every assistant use case may need; one object built from the same ports. */
export interface AssistantDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly settings: AssistantSettingsRepository;
  readonly runtime: AssistantRuntime;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}
