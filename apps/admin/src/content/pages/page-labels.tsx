import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { isKnownStatus, type PageStatus } from './page-types.ts';

export const PAGE_STATUS_TONE: Record<PageStatus, BadgeTone> = {
  default: 'neutral',
  draft: 'attention',
  scheduled: 'info',
  published: 'success',
  ended: 'neutral',
  archived: 'neutral',
};

/** The status of a page as a badge; a status this panel does not know reads "Unknown". */
export function PageStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('content.pages.status');
  const known = isKnownStatus(status);
  return (
    <Badge tone={known ? PAGE_STATUS_TONE[status] : 'neutral'}>
      {t(known ? status : 'unknown')}
    </Badge>
  );
}
