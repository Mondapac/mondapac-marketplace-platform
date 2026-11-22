'use client';

import type {
  WorkQueueCardLabels,
  WorkQueueDefinition,
  WorkQueueLevel,
  WorkQueueStatus,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { adminQueue, labelKey } from './queues.ts';

/** The panel's definition of a queue key, with its label in the panel's words. */
export function useQueueDefinitions(): (key: string) => WorkQueueDefinition | null {
  const t = useTranslations('work-queue');
  return (key) => {
    const queue = adminQueue(key);
    if (queue === null) return null;
    return { label: t(labelKey(key)), href: queue.href, signal: queue.signal };
  };
}

/** The words of a row's status ("Overdue · oldest 2d", "Due in 6h", "Incident"). */
export function useStatusText(): (status: WorkQueueStatus, age: string | null) => string {
  const t = useTranslations('work-queue.status');
  return (status, age) => {
    switch (status.kind) {
      case 'error':
        return t('error');
      case 'incident':
        return t('incident');
      case 'fix':
        return t('fix');
      case 'overdue':
        // The count already says how many are overdue when only some are (Reza): the status
        // then gives the age, in the critical tone.
        if (age === null) return t('overdue');
        if (status.deadline) return t('overdue-by', { age });
        return status.all ? t('overdue-age', { age }) : t('oldest', { age });
      case 'due-in':
        return t('due-in', { age: age ?? '' });
      case 'oldest':
        return t('oldest', { age: age ?? '' });
      case 'waiting':
      case 'clear':
        return '';
    }
  };
}

export function useLevelText(): (level: WorkQueueLevel) => string {
  const t = useTranslations('work-queue.level');
  return (level) => t(level);
}

/** The words of the dashboard's "Needs action" card. */
export function useCardLabels(): WorkQueueCardLabels {
  const t = useTranslations('work-queue');
  const status = useStatusText();
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
    status: (value: WorkQueueStatus, age: string | null) => status(value, age),
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
