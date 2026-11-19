import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { KINDS, STATUSES, type HEALTH_BANDS, type SellerRowHealth } from './types.ts';
import { known } from './format.ts';

const TONE: Record<string, BadgeTone> = {
  approved: 'success',
  'awaiting-review': 'attention',
  'changes-needed': 'attention',
  'not-approved': 'critical',
  suspended: 'critical',
  'file-check-needed': 'critical',
  'outside-service-area': 'critical',
};

const HEALTH_TONE: Record<(typeof HEALTH_BANDS)[number], BadgeTone> = {
  healthy: 'success',
  'at-risk': 'attention',
  unhealthy: 'critical',
};

/** The health cell: the band and score, or why there is none. Health only informs. */
export function HealthCell({
  health,
  unavailable,
}: {
  readonly health: SellerRowHealth | null | undefined;
  readonly unavailable: boolean;
}) {
  const t = useTranslations('sellers.list.health');
  if (health === null || health === undefined) {
    return <span className="text-fg-muted">{unavailable ? t('unavailable') : t('none')}</span>;
  }
  if (health.kind === 'new') return <Badge tone="neutral">{t('new')}</Badge>;
  if (health.kind === 'no-data' || health.band === null || health.score === null) {
    return <span className="text-fg-muted">{t('no-data')}</span>;
  }
  return (
    <Badge tone={HEALTH_TONE[health.band]}>
      {t(`band.${health.band}`)} · {health.score}
    </Badge>
  );
}

/** The status badge, with the kind of the pending submission under it. `hidden` shows a dash. */
export function StatusCell({
  status,
  kind,
}: {
  readonly status: string | null;
  readonly kind: string | null;
}) {
  const t = useTranslations('sellers.list');
  const key = known(status, [...STATUSES]);
  return (
    <span className="flex flex-col items-start">
      {key === 'hidden' ? (
        <span className="text-fg-muted">-</span>
      ) : (
        <Badge tone={TONE[key] ?? 'neutral'}>{t(`status.${key}`)}</Badge>
      )}
      {kind === null ? null : (
        <span className="mt-1 text-xs text-fg-muted">{t(`kind.${known(kind, KINDS)}`)}</span>
      )}
    </span>
  );
}
