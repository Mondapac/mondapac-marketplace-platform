import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { known } from '../sellers/format.ts';
import { BUCKETS } from './types.ts';

const BUCKET_TONE: Readonly<Record<string, BadgeTone>> = {
  'needs-response': 'attention',
  'decision-needed': 'critical',
  'under-review': 'neutral',
  won: 'success',
  closed: 'neutral',
};

/** The stage of a case (its bucket) as a badge; a stage this panel does not know reads Unknown. */
export function BucketBadge({ bucket }: { readonly bucket: string }) {
  const t = useTranslations('disputes');
  return (
    <Badge tone={BUCKET_TONE[bucket] ?? 'neutral'}>
      {t(`filter.${known(bucket, BUCKETS)}` as 'filter.closed')}
    </Badge>
  );
}
