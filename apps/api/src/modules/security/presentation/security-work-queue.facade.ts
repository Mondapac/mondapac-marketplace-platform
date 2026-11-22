import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountOpenSecurityAlerts } from '../application/use-cases/count-open-security-alerts.use-case';
import type { SecurityWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class SecurityWorkQueueFacadeImplementation implements SecurityWorkQueueFacade {
  constructor(private readonly openAlertsUseCase: CountOpenSecurityAlerts) {}

  openAlerts(context: CallContext, query: WorkQueueCountQuery) {
    return this.openAlertsUseCase.execute(context, query);
  }
}
