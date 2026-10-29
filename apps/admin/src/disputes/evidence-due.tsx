import { Badge } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { evidenceDue } from './evidence.ts';

/**
 * The evidence deadline as text: the date is always there; a deadline within three days reads
 * "In N days · 4 Nov" in the attention tone and a past one "Overdue · 4 Nov" in the critical tone.
 */
export function EvidenceDueText({
  iso,
  zone,
  now,
}: {
  readonly iso: string | null;
  readonly zone: string;
  readonly now: number;
}) {
  const t = useTranslations('disputes');
  const locale = useLocale();
  const due = iso === null ? null : evidenceDue(iso, now, locale, zone);
  if (due === null) return <span className="text-fg-muted">{t('evidence.none')}</span>;
  if (due.kind === 'later') return <span className="whitespace-nowrap">{due.date}</span>;
  if (due.kind === 'overdue') {
    return <Badge tone="critical">{t('evidence.overdue', { date: due.date })}</Badge>;
  }
  return <Badge tone="attention">{t('evidence.soon', { days: due.days, date: due.date })}</Badge>;
}
