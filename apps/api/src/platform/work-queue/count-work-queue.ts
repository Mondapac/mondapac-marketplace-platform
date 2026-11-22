import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
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
    return failed(context, error);
  }
}

/**
 * The seller of a seller-panel session: an authenticated actor of the seller population with a
 * well-formed seller id, the same test as the seller read use cases (for example ordering's seller
 * order list). The id comes from the session only, never from input. An admin in a Login as
 * Seller session reaches it the same way as those reads do: a read is allowed there. Null for any
 * other actor (fail closed).
 */
export function sessionSellerOf(context: CallContext): Id<'Seller'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  const parsed = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/**
 * One seller work-queue count of an owner module (dashboards upgrade, phase 1, seller tasks),
 * after the use case's gate: a seller-panel session with its own seller ({@link sessionSellerOf};
 * `access.denied` otherwise, so a customer or an admin acting as themselves never reads one),
 * `access.unavailable` once the dashboard stopped waiting or when the store fails, and the read in
 * one read-only unit, always for the session's seller. `prepare` runs before the unit, for what a
 * count needs from another module's facade (a facade call never runs inside a unit); its failure
 * is `access.unavailable` too, and the signal is checked again after it.
 */
export async function countSellerWorkQueue<Reader, Prepared = undefined>(
  deps: WorkQueueCountDependencies<Reader>,
  context: CallContext,
  query: WorkQueueCountQuery,
  read: (counts: Reader, sellerId: Id<'Seller'>, prepared: Prepared) => Promise<WorkQueueCount>,
  prepare?: (sellerId: Id<'Seller'>) => Promise<Prepared>,
): Promise<Result<WorkQueueCount, AccessDenied>> {
  const sellerId = sessionSellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  if (query.signal.aborted) return err({ code: 'access.unavailable' });
  try {
    const prepared = prepare === undefined ? (undefined as Prepared) : await prepare(sellerId);
    if (query.signal.aborted) return err({ code: 'access.unavailable' });
    return await deps.unitOfWork.run(
      context.market,
      async () => ok(await read(deps.counts, sellerId, prepared)),
      { readOnly: true },
    );
  } catch (error) {
    return failed(context, error);
  }
}

/** Logs a failed count by the thrown value's class only (never its message). */
function failed(context: CallContext, error: unknown): Result<never, AccessDenied> {
  // The class only (a stored-data integrity error is not a timeout); never the message.
  logger.warn({
    msg: 'work-queue.count-failed',
    thrown: nameOf(error),
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return err({ code: 'access.unavailable' });
}
