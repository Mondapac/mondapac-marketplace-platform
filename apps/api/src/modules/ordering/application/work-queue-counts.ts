import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor, type AccessDenied } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';
import type { WorkQueueCountReader } from './ports/work-queue-count.reader';

export interface WorkQueueCountDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counts: WorkQueueCountReader;
}

/**
 * One dashboard count of an ordering queue (dashboards upgrade, phase 1): a platform admin acting
 * as themselves only, one read-only unit, `access.unavailable` once the dashboard stopped waiting
 * (its signal) or when the store fails.
 */
export async function countQueue(
  deps: WorkQueueCountDependencies,
  context: CallContext,
  query: WorkQueueCountQuery,
  read: (counts: WorkQueueCountReader) => Promise<WorkQueueCount>,
): Promise<Result<WorkQueueCount, AccessDenied>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  if (query.signal.aborted) return err({ code: 'access.unavailable' });
  try {
    return await deps.unitOfWork.run(context.market, async () => ok(await read(deps.counts)), {
      readOnly: true,
    });
  } catch {
    return err({ code: 'access.unavailable' });
  }
}
