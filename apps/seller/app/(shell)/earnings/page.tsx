import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { Earnings } from '../../../src/earnings/earnings.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { loadEarningsPage } from '../../../src/server/earnings-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('earnings.title') };
}

export default async function EarningsPage() {
  const t = await getTranslations();
  const title = t('earnings.title');
  const page = await loadEarningsPage();
  if (page.kind === 'unavailable') {
    return <LoadError message={t('earnings.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind === 'no-access') {
    return (
      <SellerShell session={page.session} activeId="s_earnings" title={title}>
        <PageHeader title={t('catalog.no-access.title')} className="mb-2" />
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <SellerShell session={page.session} activeId="s_earnings" title={title}>
      <PageHeader title={title} className="mb-4" />
      <Earnings
        initial={page.ledger}
        disputes={page.disputes}
        payouts={page.payouts}
        accountId={page.session.accountId}
        marketId={marketId}
      />
    </SellerShell>
  );
}
