'use client';

import {
  ChartCardSkeleton,
  DashboardCard,
  DashboardSlot,
  WorkQueueCard,
  needsAction,
  workQueueRows,
  type DashboardSource,
  type WorkQueueAnswer,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { Widget } from '../dashboard/types.ts';
import { useCardLabels, useQueueDefinitions } from './labels.ts';
import { WORK_QUEUE_PAGE } from './queues.ts';

const ID = 'dash-needs-action';

function Card({ widget }: { readonly widget: Widget<WorkQueueAnswer> }) {
  const t = useTranslations('work-queue');
  const td = useTranslations('dashboard');
  const locale = useLocale();
  const labels = useCardLabels();
  const define = useQueueDefinitions();
  if (widget.kind === 'error') {
    return (
      <DashboardCard id={ID} title={labels.title} scope={labels.scope} error={td('error.card')} />
    );
  }
  const rows = workQueueRows(widget.value, define);
  const generated = Date.parse(widget.value.generatedAt);
  return (
    <WorkQueueCard
      id={ID}
      rows={rows}
      labels={labels}
      locale={locale}
      now={Number.isNaN(generated) ? Date.now() : generated}
      open={{
        href: WORK_QUEUE_PAGE,
        label: t('open', { count: rows.filter(needsAction).length }),
      }}
      levelHref={(level) => `${WORK_QUEUE_PAGE}?view=${level}`}
    />
  );
}

/**
 * The dashboard's "Needs action" card (design section 2): its skeleton while the work queue is
 * read, then the card. Absent when the session holds no queue's key or the API shows none.
 */
export function NeedsAction({
  source,
}: {
  readonly source: DashboardSource<Widget<WorkQueueAnswer> | null> | null;
}) {
  const t = useTranslations('work-queue');
  const tr = useTranslations();
  if (source === null) return null;
  return (
    <DashboardSlot
      source={source}
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
