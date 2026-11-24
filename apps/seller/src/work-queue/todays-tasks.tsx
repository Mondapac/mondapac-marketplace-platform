'use client';

import {
  ChartCardSkeleton,
  DashboardCard,
  DashboardSlot,
  WorkQueueCard,
  workQueueRows,
  type DashboardSource,
  type GridLayout,
  type WorkQueueCardLabels,
  type WorkQueueDefinition,
  type WorkQueueLevel,
  type WorkQueueRow,
  type WorkQueueStatus,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { Widget } from '../dashboard/types.ts';
import { labelKey, sellerQueue, type WorkQueueAnswer } from './queues.ts';

const ID = 'dash-tasks';

function useDefinitions(): (key: string) => WorkQueueDefinition | null {
  const t = useTranslations('tasks');
  return (key) => {
    const queue = sellerQueue(key);
    if (queue === null) return null;
    return { label: t(labelKey(key)), href: queue.href, signal: queue.signal };
  };
}

function useLabels(): WorkQueueCardLabels {
  const t = useTranslations('tasks');
  const status = (value: WorkQueueStatus, age: string | null, row: WorkQueueRow): string => {
    switch (value.kind) {
      case 'error':
        return t('status.error');
      case 'incident':
        return t('status.incident');
      case 'fix':
        return t('status.fix');
      case 'overdue':
        // The count already says how many are overdue when only some are: the status then
        // gives the age, in the critical tone.
        if (age === null || sellerQueue(row.key)?.showsAge === false) return t('status.overdue');
        if (value.deadline) return t('status.overdue-by', { age });
        return value.all ? t('status.overdue-age', { age }) : t('status.oldest', { age });
      case 'due-in':
        return t('status.due-in', { age: age ?? '' });
      case 'oldest':
        return sellerQueue(row.key)?.showsAge === false
          ? ''
          : t('status.oldest', { age: age ?? '' });
      case 'waiting':
      case 'clear':
        return '';
    }
  };
  return {
    title: t('title'),
    scope: t('scope'),
    group: (level: WorkQueueLevel, shown: number, total: number) =>
      level === 'today' && shown < total
        ? t('group.today-top', { shown, total })
        : t(`group.${level}`, { count: total }),
    count: (count: number, overdue: number) =>
      overdue > 0 && overdue < count
        ? t('count-overdue', { count, overdue })
        : t('count', { count }),
    status,
    todayMore: (count: number) => t('today-more', { count }),
    reviewLine: (names: readonly string[], more: number) =>
      more > 0
        ? t('review-line-more', { first: names[0] ?? '', second: names[1] ?? '', more })
        : t('review-line', { first: names[0] ?? '', second: names[1] ?? '' }),
    oldest: (age: string) => t('status.oldest', { age }),
    clear: (count: number) => t('clear', { count }),
    allClear: t('all-clear'),
    someFailed: t('some-failed'),
  };
}

function Card({ widget }: { readonly widget: Widget<WorkQueueAnswer> }) {
  const td = useTranslations('dashboard');
  const locale = useLocale();
  const labels = useLabels();
  const define = useDefinitions();
  if (widget.kind === 'error') {
    return (
      <DashboardCard id={ID} title={labels.title} scope={labels.scope} error={td('error.card')} />
    );
  }
  const generated = Date.parse(widget.value.generatedAt);
  return (
    <WorkQueueCard
      id={ID}
      rows={workQueueRows(widget.value, define)}
      labels={labels}
      locale={locale}
      now={Number.isNaN(generated) ? Date.now() : generated}
    />
  );
}

/**
 * The seller dashboard's "Today's tasks" card (design section 3): the store's own work, most
 * urgent first, each task linked to the page where it is done. Its skeleton while the tasks are
 * read; absent when the member holds no task's key or the API shows none the panel knows.
 */
export function TodaysTasks({
  source,
  layout,
}: {
  readonly source: DashboardSource<Widget<WorkQueueAnswer> | null> | null;
  /** Places the card in a DashboardGrid (span, phone order). */
  readonly layout?: GridLayout;
}) {
  const t = useTranslations('tasks');
  const tr = useTranslations();
  if (source === null) return null;
  return (
    <DashboardSlot
      source={source}
      {...(layout === undefined ? {} : { layout })}
      fallback={
        <ChartCardSkeleton
          id={ID}
          title={t('title')}
          scope={t('scope')}
          height={160}
          slowLabel={tr('route.slow')}
          stalledLabel={tr('dashboard.error.card')}
        />
      }
    >
      {(widget) => (widget === null ? null : <Card widget={widget} />)}
    </DashboardSlot>
  );
}
