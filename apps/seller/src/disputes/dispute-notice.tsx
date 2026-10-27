import { Banner } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMinor } from '../price/money.ts';
import type { OwnDispute } from './types.ts';

/**
 * What the seller is told about a disputed order, and nothing more: that the payment is disputed
 * and held, or that the dispute closed and what was taken. Nothing is shown for a closed dispute
 * that took nothing. No reason, no deadline, no card or buyer data, no help link.
 */
export function DisputeNotice({ dispute }: { readonly dispute: OwnDispute | null }) {
  const t = useTranslations('disputes');
  const locale = useLocale();
  if (dispute === null) return null;
  if (dispute.open) {
    return (
      <Banner tone="critical" title={t('badge')}>
        <p>{t('held')}</p>
      </Banner>
    );
  }
  if (dispute.recoveredAmount === null) return null;
  return (
    <Banner tone="attention">
      {t('closed-recovered', {
        amount: formatMinor(
          dispute.recoveredAmount.amountMinor,
          dispute.recoveredAmount.currency,
          locale,
        ),
      })}
    </Banner>
  );
}
