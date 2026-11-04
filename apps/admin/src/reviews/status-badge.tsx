import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

const TONE: Readonly<Record<string, BadgeTone>> = {
  published: 'success',
  held: 'attention',
  hidden: 'neutral',
  removed: 'critical',
  'deleted-by-author': 'neutral',
};

export function StatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('reviews-moderation');
  return <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>;
}
