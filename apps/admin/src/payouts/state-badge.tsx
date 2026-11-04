import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { PAYOUT_STATES, type PayoutState } from './types.ts';

const TONE: Readonly<Record<PayoutState, BadgeTone>> = {
  pending: 'neutral',
  'awaiting-approval': 'attention',
  approved: 'info',
  instructing: 'info',
  instructed: 'info',
  paid: 'success',
  failed: 'critical',
  'not-sent': 'neutral',
  voided: 'neutral',
  'settled-by-netting': 'neutral',
};

/** The state of a payout. A state this panel does not know shows as Unknown, never a guess. */
export function StateBadge({ state }: { readonly state: string }) {
  const t = useTranslations('payouts');
  const known = (PAYOUT_STATES as readonly string[]).includes(state)
    ? (state as PayoutState)
    : null;
  return (
    <Badge tone={known === null ? 'neutral' : TONE[known]}>
      {known === null ? t('state.unknown') : t(`state.${known}`)}
    </Badge>
  );
}
