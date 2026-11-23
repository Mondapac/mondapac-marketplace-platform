import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CustomerDetail } from '../../../../src/customers/customer-detail.tsx';
import { CUSTOMERS_VIEW_PERMISSION } from '../../../../src/customers/types.ts';
import { catalogGate } from '../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.detail.title') };
}

export default async function CustomerPage({
  params,
}: {
  readonly params: Promise<{ readonly code: string }>;
}) {
  const { code } = await params;
  const t = await getTranslations();
  const title = t('customers.title');
  const gate = await catalogGate(CUSTOMERS_VIEW_PERMISSION);
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('catalog.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (gate.kind === 'no-access') {
    return (
      <SellerShell session={gate.session} activeId="s_customers" title={title}>
        <PageHeader title={t('catalog.no-access.title')} className="mb-2" />
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  return (
    <SellerShell session={gate.session} activeId="s_customers" title={title}>
      <CustomerDetail code={code} />
    </SellerShell>
  );
}
