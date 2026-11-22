import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied, PermissionKey } from '../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../platform/work-queue/work-queue-count';

/** The panels with a work queue. */
export type WorkQueuePanel = 'admin' | 'seller';

/**
 * The urgency group of a queue (design section 2): `critical` is an incident or a deadline that
 * is about to pass, `today` is work due within the day, `review` is a review queue that may wait.
 */
export type WorkQueueLevel = 'critical' | 'today' | 'review';

export const WORK_QUEUE_LEVELS: readonly WorkQueueLevel[] = ['critical', 'today', 'review'];

/**
 * The default age after which an item of a queue without its own deadline is overdue (design
 * section 2: today 48 hours, review 7 days; critical queues have their own deadlines, and one
 * without counts after 1 hour). Settings may override it later (future-enhancements register).
 */
export const STALE_AFTER_MINUTES: Readonly<Record<WorkQueueLevel, number>> = Object.freeze({
  critical: 60,
  today: 48 * 60,
  review: 7 * 24 * 60,
});

/**
 * One queue of a panel's work queue, as the dashboard module binds it to its owner's facade.
 *
 * - `requires`: the keys the viewer must hold for the queue to be asked at all. The owner's use
 *   case checks its own rule again (defence in depth); its `access.denied` hides the queue too.
 * - `live`: never cached (security alerts, disputes, halal listings: design section 6).
 * - `staleAfterMinutes`: the queue's own age limit, when design section 2 gives it one (the failed
 *   payments, webhooks and payouts: 1 hour); otherwise its level's {@link STALE_AFTER_MINUTES}.
 * - `count`: the owner's facade method, called with the viewer's `CallContext` unchanged.
 */
export interface WorkQueueSource {
  /** `<module>.<queue>`, unique in its panel; the panel maps it to its label and link. */
  readonly key: string;
  readonly panel: WorkQueuePanel;
  readonly level: WorkQueueLevel;
  readonly requires: readonly PermissionKey[];
  readonly live: boolean;
  readonly staleAfterMinutes?: number;
  count(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied | { readonly code: string }>>;
}

/** The sources of every panel, bound by the dashboard module's providers. */
export const WORK_QUEUE_SOURCES = Symbol('WORK_QUEUE_SOURCES');

/** The pattern of a queue key: two lower-case kebab segments. */
export const WORK_QUEUE_KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/**
 * Checks the bound sources at start: a bad key, a duplicate key in one panel or a source without
 * any required key is a coding error, so the module refuses to boot.
 */
export function checkWorkQueueSources(sources: readonly WorkQueueSource[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (!WORK_QUEUE_KEY_PATTERN.test(source.key)) {
      throw new Error(`dashboard: work queue key ${source.key} is not <module>.<queue>`);
    }
    const id = `${source.panel}:${source.key}`;
    if (seen.has(id)) throw new Error(`dashboard: work queue ${id} is bound twice`);
    seen.add(id);
    if (source.requires.length === 0) {
      throw new Error(`dashboard: work queue ${id} requires no permission key`);
    }
    const limit = source.staleAfterMinutes;
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
      throw new Error(`dashboard: work queue ${id} has a bad age limit`);
    }
  }
}
