import { getTranslations } from 'next-intl/server';
import type { ReviewStanding } from './types.ts';

/**
 * The probation progress (risk-based Offer approval slice 7): "3 of 10 offers checked" while a
 * new seller's first offers are reviewed, and the shorter run after a take-down. Nothing shows
 * once the seller is through it, or when the progress could not be read. It says nothing about
 * sampling or why an offer was held.
 */
export async function ProbationBar({ standing }: { readonly standing: ReviewStanding | null }) {
  if (standing === null || standing.status !== 'probation' || standing.target < 1) return null;
  const t = await getTranslations();
  const count = Math.min(standing.count, standing.target);
  const percent = Math.round((count / standing.target) * 100);
  const label = t('catalog.probation.progress', { count, target: standing.target });
  return (
    <section
      aria-label={t('catalog.probation.title')}
      className="rounded-md border border-line bg-surface px-4 py-3 text-sm"
    >
      <p className="font-medium">
        {standing.restarted ? t('catalog.probation.restarted') : t('catalog.probation.title')}
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={standing.target}
        aria-valuenow={count}
        aria-valuetext={label}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line"
      >
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-fg-muted">{label}</p>
      <p className="mt-1 text-fg-muted">{t('catalog.probation.help')}</p>
    </section>
  );
}
