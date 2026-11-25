'use client';

import { Badge } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatInstantInZone } from '../shared/format.ts';
import type { Standing } from './standing.ts';

/**
 * A seller's Offer review standing in words and a bar: Trusted or Probation, the approved first
 * publications against the target (text first, the bar only repeats it), where Trusted came from,
 * and the notes the API gives (a target shortened after a misconduct removal, the changes-needed
 * streak). Shown on the seller page and, compact, in the decision drawer.
 */
export function StandingSummary({
  standing,
  zone,
}: {
  readonly standing: Standing;
  readonly zone: string;
}) {
  const t = useTranslations('offer-review.standing');
  const locale = useLocale();
  const trusted = standing.status === 'trusted';
  const percent =
    standing.target === 0
      ? 100
      : Math.min(100, Math.round((standing.count / standing.target) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={trusted ? 'success' : 'attention'}>
          {t(trusted ? 'trusted' : 'probation')}
        </Badge>
        {trusted && standing.source !== null ? (
          <span className="text-sm text-fg-muted">
            {t(standing.source === 'admin' ? 'source-admin' : 'source-count')}
          </span>
        ) : null}
        {trusted && standing.trustedSince !== null ? (
          <span className="text-sm text-fg-muted">
            {t('since', { when: formatInstantInZone(standing.trustedSince, locale, zone) })}
          </span>
        ) : null}
      </div>
      <div>
        <p className="m-0 text-sm">
          {t('progress', { count: standing.count, target: standing.target })}
        </p>
        <div
          role="progressbar"
          aria-label={t('progress-label')}
          aria-valuemin={0}
          aria-valuemax={standing.target}
          aria-valuenow={Math.min(standing.count, standing.target)}
          className="mt-1 h-2 w-full max-w-sm overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {standing.targetKind === 'after-misconduct' ? (
        <p className="m-0 text-sm text-fg-muted">{t('after-misconduct')}</p>
      ) : null}
      {standing.consecutiveChangesNeeded > 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          {t('streak', { count: standing.consecutiveChangesNeeded })}
        </p>
      ) : null}
    </div>
  );
}
