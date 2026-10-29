import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

const TONE: Readonly<Record<string, BadgeTone>> = {
  withdrawn: 'critical',
  inquiry: 'neutral',
  reinstated: 'success',
};

/** What the bank is doing with the money of a case. No badge when nothing moved. */
export function MoneyStateBadge({ state }: { readonly state: string }) {
  const t = useTranslations('disputes');
  const tone = TONE[state];
  if (tone === undefined) return null;
  return <Badge tone={tone}>{t(`money.${state}`)}</Badge>;
}
