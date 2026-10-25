import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  blockCountDay,
  blockCountRetentionEdge,
  incrementsOf,
  readBlockEvents,
  type BlockEvent,
  type BlockFieldProblem,
} from '../domain/block-count';
import type { BlockCountRepository } from './ports/block-count.repository';
import type { ServedPlacements } from './ports/served-placements';

// Block counts (personalization package 1d-3, part B). The storefront reports that a block was
// shown or clicked; engagement adds one to that block's count of the UTC day. Nothing about the
// sender is read: not the session, a cookie, the address or the browser. An event is counted only
// when storefront says the placement is served now on that page in the Market, so random ids make
// no rows; an event that is not counted is skipped without a sign.

export interface BlockCountDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counts: BlockCountRepository;
  /** The placements served now on a page, from storefront's public contract. */
  readonly served: ServedPlacements;
  readonly clock: Clock;
}

export type RecordBlockEventsFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly BlockFieldProblem[];
};

export interface RecordBlockEventsInput {
  /** The `events` of the request body, unchecked. */
  readonly events: unknown;
  /** `Sec-GPC: 1` on the request: nothing is counted. */
  readonly globalPrivacyControl: boolean;
}

/**
 * Counts the events of one request. The body is checked first (so a malformed body is a 400 with
 * or without Global Privacy Control); with Global Privacy Control nothing is read or counted.
 * Identical events count once. `recorded` says whether anything was counted, for the route's own
 * log; it is never part of the answer.
 */
export async function recordBlockEvents(
  deps: BlockCountDependencies,
  context: CallContext,
  input: RecordBlockEventsInput,
): Promise<Result<{ readonly recorded: boolean }, RecordBlockEventsFailure>> {
  const read = readBlockEvents(input?.events);
  if (!read.ok) return err({ code: 'validation.failed', fields: read.fields });
  if (input.globalPrivacyControl) return ok({ recorded: false });

  // One storefront read per distinct page. A page storefront cannot answer for is not counted.
  const served = new Map<string, ReadonlySet<string>>();
  for (const pageId of new Set(read.events.map((event) => event.pageId))) {
    served.set(pageId, await deps.served.of(context, pageId));
  }
  const counted: BlockEvent[] = read.events.filter((event) =>
    served.get(event.pageId)?.has(event.placementId),
  );
  if (counted.length === 0) return ok({ recorded: false });

  const now = deps.clock.now();
  const increments = incrementsOf(counted);
  return deps.unitOfWork.run<{ readonly recorded: boolean }, RecordBlockEventsFailure>(
    context.market,
    async () => {
      await deps.counts.increment(context.market, blockCountDay(now), now, increments);
      return ok({ recorded: true });
    },
  );
}

/**
 * Deletes, for one Market, the daily counts older than 13 months. Safe to run twice and
 * concurrently.
 */
export async function purgeExpiredBlockCounts(
  deps: Pick<BlockCountDependencies, 'unitOfWork' | 'counts' | 'clock'>,
  context: CallContext,
): Promise<Result<{ readonly blockCounts: number }, never>> {
  const edge = blockCountRetentionEdge(deps.clock.now());
  return deps.unitOfWork.run(context.market, async () =>
    ok({ blockCounts: await deps.counts.purgeBefore(context.market, edge) }),
  );
}
