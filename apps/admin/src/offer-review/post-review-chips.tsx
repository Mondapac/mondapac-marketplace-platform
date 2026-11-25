'use client';

import { Badge } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { reasonChipKeys, type PostReviewRow } from './post-review-types.ts';

/**
 * Why a published Offer is in the post-publication list: one chip per reason ("Sample", "Sample
 * ×2" for a doubled draw, "Price: no reference" ...). A price found outside the band on re-check
 * is drawn in the attention tone, the rest neutral; the text is always there, so the tone is never
 * the only signal. The chips carry no price or median (the catalog answer has none).
 */
export function PostReviewChips({
  row,
}: {
  readonly row: Pick<PostReviewRow, 'reasons' | 'sampleDoubled'>;
}) {
  const t = useTranslations('offer-review.post.reason');
  const chips = reasonChipKeys(row);
  if (chips.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={t('label')}>
      {chips.map(({ code, key }) => (
        <li key={code}>
          <Badge tone={code === 'price-recheck-outside' ? 'attention' : 'neutral'}>
            {key === null ? code : t(key)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
