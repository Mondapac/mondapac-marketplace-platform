'use client';

import { Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { IMPACT_LABELS, type ImpactLabel, type RequestImpact } from './types.ts';

const isKnown = (label: string): label is ImpactLabel =>
  (IMPACT_LABELS as readonly string[]).includes(label);

/**
 * How many records the change touches ("1,240 products", "at least 10,000 Offers"), as the owning
 * module counted it when the request was opened: a guide to its weight before the decision. Shown
 * only when the API sends counts (an open request whose values the admin may see); a label this
 * build does not know is left out.
 */
export function RequestImpactCard({
  impact,
}: {
  readonly impact: RequestImpact | null | undefined;
}) {
  const t = useTranslations('system-requests.impact');
  const items = (impact?.items ?? []).filter((item) => isKnown(item.label));
  if (items.length === 0) return null;
  return (
    <Card title={t('title')}>
      <p className="text-sm text-fg-secondary">{t('hint')}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const text = t(`item.${item.label as ImpactLabel}`, { count: item.count });
          return (
            <li key={item.label} className="break-words text-fg">
              {item.atLeast ? t('at-least', { text }) : text}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
