import { Logger } from '@nestjs/common';
import type { CallContext, Clock, Temporal } from '@mondapac/shared-kernel';
import {
  isWorkQueueCount,
  type WorkQueueCount,
} from '../../../platform/work-queue/work-queue-count';
import type { DashboardViewer } from './ports/viewer-permissions';
import type { WorkQueueCache } from './work-queue-cache';
import {
  STALE_AFTER_MINUTES,
  WORK_QUEUE_LEVELS,
  type WorkQueueLevel,
  type WorkQueuePanel,
  type WorkQueueSource,
} from './work-queue-source';

/** How long one queue may take before it answers `error` (design section 6: 1.5 seconds). */
export const WORK_QUEUE_TIMEOUT_MS = 1_500;

/** One queue of the answer: its count, or `error` when it failed or took too long (never zero). */
export type WorkQueueItem =
  | {
      readonly key: string;
      readonly level: WorkQueueLevel;
      readonly status: 'ok';
      readonly count: number;
      readonly overdue: number;
      readonly oldestAt: Temporal.Instant | null;
      readonly countedAt: Temporal.Instant;
    }
  | { readonly key: string; readonly level: WorkQueueLevel; readonly status: 'error' };

export interface WorkQueueAnswer {
  readonly panel: WorkQueuePanel;
  readonly generatedAt: Temporal.Instant;
  readonly queues: readonly WorkQueueItem[];
}

export interface WorkQueueFlowDependencies {
  readonly sources: readonly WorkQueueSource[];
  readonly cache: WorkQueueCache;
  readonly clock: Clock;
  /** {@link WORK_QUEUE_TIMEOUT_MS} outside tests. */
  readonly timeoutMs: number;
}

const TIMED_OUT = Symbol('timed-out');

/** Runs `work`, or answers {@link TIMED_OUT} after `ms`; the timer never holds the process. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

const logger = new Logger('WorkQueue');

/**
 * Composes one panel's work queue (design section 6): asks, at the same time, every queue of the
 * panel whose keys the viewer holds, each with the caller's context unchanged and at most
 * `timeoutMs`. A queue that fails, takes too long or answers a malformed count is `error`; one
 * whose owner refuses the viewer (`access.denied`, `access.seller-not-approved`) is left out, as one
 * the viewer holds no key for. The whole answer never fails for one queue. Counts of queues that
 * are not `live` are kept for 60 seconds under the viewer's whole permission set.
 */
export async function composeWorkQueue(
  deps: WorkQueueFlowDependencies,
  context: CallContext,
  panel: WorkQueuePanel,
  viewer: DashboardViewer,
): Promise<WorkQueueAnswer> {
  const now = deps.clock.now();
  const held = new Set(viewer.permissionKeys);
  const chosen = deps.sources.filter(
    (source) => source.panel === panel && source.requires.every((key) => held.has(key)),
  );
  const items = await Promise.all(
    chosen.map((source) => askOne(deps, context, panel, viewer, source, now)),
  );
  const rank = (level: WorkQueueLevel) => WORK_QUEUE_LEVELS.indexOf(level);
  const queues = items
    .filter((item): item is WorkQueueItem => item !== null)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.level) - rank(b.item.level) || a.index - b.index)
    .map(({ item }) => item);
  return { panel, generatedAt: now, queues };
}

async function askOne(
  deps: WorkQueueFlowDependencies,
  context: CallContext,
  panel: WorkQueuePanel,
  viewer: DashboardViewer,
  source: WorkQueueSource,
  now: Temporal.Instant,
): Promise<WorkQueueItem | null> {
  const { key, level } = source;
  const cacheKey = {
    marketId: context.market.marketId,
    tenantId: context.market.tenantId,
    panel,
    permissionKeys: viewer.permissionKeys,
    sellerId: panel === 'seller' ? viewer.sellerId : null,
    queue: key,
  };
  if (!source.live) {
    const kept = deps.cache.get(cacheKey, now);
    if (kept !== undefined) return okItem(source, kept.count, kept.countedAt);
  }
  const staleBefore = now.subtract({ minutes: STALE_AFTER_MINUTES[level] });
  let answer: Awaited<ReturnType<WorkQueueSource['count']>> | typeof TIMED_OUT;
  try {
    answer = await within(source.count(context, { now, staleBefore }), deps.timeoutMs);
  } catch {
    answer = { ok: false, error: { code: 'internal' } };
  }
  if (answer === TIMED_OUT) {
    log(context, key, 'timeout');
    return { key, level, status: 'error' };
  }
  if (!answer.ok) {
    const { code } = answer.error;
    if (code === 'access.denied' || code === 'access.seller-not-approved') return null;
    log(context, key, code);
    return { key, level, status: 'error' };
  }
  if (!isWorkQueueCount(answer.value)) {
    log(context, key, 'malformed');
    return { key, level, status: 'error' };
  }
  if (!source.live) deps.cache.set(cacheKey, answer.value, now);
  return okItem(source, answer.value, now);
}

function okItem(
  source: WorkQueueSource,
  count: WorkQueueCount,
  countedAt: Temporal.Instant,
): WorkQueueItem {
  return {
    key: source.key,
    level: source.level,
    status: 'ok',
    count: count.count,
    overdue: count.overdue,
    oldestAt: count.oldestAt,
    countedAt,
  };
}

function log(context: CallContext, queue: string, outcome: string): void {
  logger.warn({
    msg: 'dashboard.work-queue-source-failed',
    queue,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}
