import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { IssuerState } from './types.ts';

const TONE: Readonly<Record<IssuerState, BadgeTone>> = {
  proposed: 'neutral',
  active: 'success',
  'closed-to-new': 'attention',
  derecognised: 'critical',
};

/** The state in words, never colour alone. */
export function IssuerStateBadge({ state }: { readonly state: IssuerState }) {
  const t = useTranslations('certificates.issuers.state');
  return <Badge tone={TONE[state]}>{t(state)}</Badge>;
}
