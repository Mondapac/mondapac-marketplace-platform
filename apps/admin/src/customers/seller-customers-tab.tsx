'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { SellerCustomersList } from './seller-customers-list.tsx';
import { SellerCustomersSummaryCard } from './seller-customers-summary.tsx';

/**
 * The Customers tab of a seller (customers management phase 3): the counts and 12-month trend,
 * then the seller's customers as a super list. Each section is under its own key read: a 403 hides
 * that section (not an error); when both are hidden the page says the role has no access.
 */
export function SellerCustomersTab({
  sellerId,
  accountId,
  marketId,
  zone,
  paging,
  csrfToken,
}: {
  readonly sellerId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly csrfToken: string;
}) {
  const t = useTranslations('customers.seller-tab');
  const [summaryDenied, setSummaryDenied] = useState(false);
  const [listDenied, setListDenied] = useState(false);
  const denySummary = useCallback(() => setSummaryDenied(true), []);
  const denyList = useCallback(() => setListDenied(true), []);

  if (summaryDenied && listDenied) {
    return <p className="text-fg-muted">{t('no-access')}</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      <SellerCustomersSummaryCard sellerId={sellerId} onDenied={denySummary} />
      <SellerCustomersList
        sellerId={sellerId}
        accountId={accountId}
        marketId={marketId}
        zone={zone}
        paging={paging}
        csrfToken={csrfToken}
        onDenied={denyList}
      />
    </div>
  );
}
