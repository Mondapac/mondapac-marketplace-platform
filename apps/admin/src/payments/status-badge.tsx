import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { known } from '../sellers/format.ts';
import { STATUSES } from './types.ts';

const TONE: Record<string, BadgeTone> = {
  'not-connected': 'neutral',
  'not-started': 'neutral',
  pending: 'attention',
  enabled: 'success',
  restricted: 'attention',
  rejected: 'critical',
};

/** The status of a connected account as a badge; an unlisted value reads "Unknown". */
export function AccountStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('payments.accounts');
  const key = known(status, STATUSES);
  return <Badge tone={TONE[key] ?? 'neutral'}>{t(`status.${key}`)}</Badge>;
}

/** A yes/no flag as a badge: `tone` when it is yes, neutral when it is no. */
export function FlagBadge({ on, tone }: { readonly on: boolean; readonly tone: BadgeTone }) {
  const t = useTranslations('payments.accounts');
  return <Badge tone={on ? tone : 'neutral'}>{t(on ? 'yes' : 'no')}</Badge>;
}
