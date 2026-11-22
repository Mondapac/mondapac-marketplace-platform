import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor, type AccessDenied } from '../authz';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import type { WorkQueueCount, WorkQueueCountQuery } from './work-queue-count';

const logger = new Logger('WorkQueueCount');

/** The class name of a thrown value (never its message): enough to trace, nothing to leak. */
function nameOf(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'unknown';
}

/** What an owner's count use case needs: a read-only unit and its own count reader. */
export interface WorkQueueCountDependencies<Reader> {
  readonly unitOfWork: UnitOfWork;
  readonly counts: Reader;
}

/**
 * One admin work-queue count of an owner module (dashboards upgrade, phase 1), after the use
 * case's gate: a platform admin acting as themselves only (`access.denied` otherwise, so an
 * acting-as session or a seller never reads a platform-wide count), `access.unavailable` once the
 * dashboard stopped waiting (its signal) or when the store fails, and the read in one read-only
 * unit (ADR-0025: no transaction, so the reader's counts run side by side).
 */
export async function countAdminWorkQueue<Reader>(
  deps: WorkQueueCountDependencies<Reader>,
  context: CallContext,
  query: WorkQueueCountQuery,
  read: (counts: Reader) => Promise<WorkQueueCount>,
): Promise<Result<WorkQueueCount, AccessDenied>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  if (query.signal.aborted) return err({ code: 'access.unavailable' });
  try {
    return await deps.unitOfWork.run(context.market, async () => ok(await read(deps.counts)), {
      readOnly: true,
    });
  } catch (error) {
    // The class only (a stored-data integrity error is not a timeout); never the message.
    logger.warn({
      msg: 'work-queue.count-failed',
      thrown: nameOf(error),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
}
