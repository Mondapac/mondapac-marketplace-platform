'use client';

import { Badge } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DANGER_REASONS, isKnownReason } from './types.ts';

/**
 * Why a row waits for a person: one chip per reason code with its letter code and name ("R2
 * Certificate badge"). R0 and R2 are drawn in the critical tone, the rest neutral; the text is
 * always there, so the tone is never the only signal. A code this panel does not know shows as it
 * came, in the neutral tone.
 */
export function ReasonChips({ reasons }: { readonly reasons: readonly string[] }) {
  const t = useTranslations('offer-review.reason');
  if (reasons.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={t('label')}>
      {reasons.map((code) => (
        <li key={code}>
          <Badge tone={DANGER_REASONS.has(code) ? 'critical' : 'neutral'}>
            {isKnownReason(code) ? t(code) : code}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
