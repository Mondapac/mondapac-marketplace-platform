import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { Id } from '@mondapac/shared-kernel';
import type { ReportRetiredCategories } from '../../application/use-cases/report-retired-categories.use-case';
import {
  PlatformCategoryArchived,
  PlatformCategoryMerged,
  PlatformCategoryMoved,
} from '../../domain/events';

/** The subscriber names: also the `handler` of `catalog.inbox`. */
export const REPORT_MOVED_CATEGORY = 'catalog.report-moved-category';
export const REPORT_MERGED_CATEGORY = 'catalog.report-merged-category';
export const REPORT_ARCHIVED_CATEGORY = 'catalog.report-archived-category';

/**
 * Catalog's own subscriptions to its category move, merge and archive events (C4a; certification
 * request C-4; review of #707): an entry adapter only. The delivery and the Market's system-actor
 * context go unchanged to the one `system` use case with the payload's `checkedIds`, the ids the
 * check cleared before the change. A refusal throws, so the delivery
 * is retried and, after its last attempt, dead-lettered with an alert.
 */
export function categoryRetirementSubscriptions(
  report: ReportRetiredCategories,
): RegisteredSubscription[] {
  const run = async (
    name: string,
    checkedIds: readonly string[],
    delivery: Parameters<ReportRetiredCategories['execute']>[1]['delivery'],
    context: Parameters<ReportRetiredCategories['execute']>[0],
  ): Promise<void> => {
    const result = await report.execute(context, {
      delivery,
      categoryIds: checkedIds as readonly Id<'Category'>[],
    });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: REPORT_MOVED_CATEGORY,
      event: PlatformCategoryMoved,
      handle: (event, delivery, context) =>
        run(REPORT_MOVED_CATEGORY, event.payload.checkedIds, delivery, context),
    }),
    subscription({
      name: REPORT_MERGED_CATEGORY,
      event: PlatformCategoryMerged,
      handle: (event, delivery, context) =>
        run(REPORT_MERGED_CATEGORY, event.payload.checkedIds, delivery, context),
    }),
    subscription({
      name: REPORT_ARCHIVED_CATEGORY,
      event: PlatformCategoryArchived,
      handle: (event, delivery, context) =>
        run(REPORT_ARCHIVED_CATEGORY, event.payload.checkedIds, delivery, context),
    }),
  ];
}
