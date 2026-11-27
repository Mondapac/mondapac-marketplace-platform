'use client';

import { Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { SellerAccountState } from './types.ts';

const ACCOUNT_TONE: Readonly<Record<SellerAccountState, string>> = {
  approved: 'text-success-fg',
  'details-incomplete': 'text-fg-muted',
  ready: 'text-fg-muted',
  'outside-area': 'text-attention-fg',
  'awaiting-review': 'text-fg-muted',
  'changes-needed': 'text-attention-fg',
  'not-approved': 'text-critical-fg',
};

/**
 * The seller account's own state on a line of its own (CERT-12): the account and a certificate
 * are two states, never one. Shown on the list and on every status page.
 */
export function SellerAccountLine({ account }: { readonly account: SellerAccountState }) {
  const t = useTranslations();
  return (
    <p className="text-sm text-fg-secondary" data-testid="seller-state">
      {t('certification.seller-state.line', {
        status: t(`certification.seller-state.${account}`),
      })}
      <span className={`ms-1 inline-flex align-middle ${ACCOUNT_TONE[account]}`} aria-hidden>
        <Icon name={account === 'approved' ? 'check' : 'clock'} />
      </span>
    </p>
  );
}
