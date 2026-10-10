import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { loadStockPage } from '../../../src/server/stock-page.ts';
import { StockLocations } from '../../../src/stock/stock-locations.tsx';
import { SOURCE_EDIT_PERMISSION } from '../../../src/stock/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('stock.title') };
}

export default async function StockLocationsPage() {
  const t = await getTranslations();
  const title = t('stock.title');
  const page = await loadStockPage();
  if (page.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('stock.error.unavailable')}</p>;
  }
  if (page.kind === 'no-access') {
    return (
      <SellerShell session={page.session} activeId="s_stock" title={title}>
        <h1 className="mb-2 text-2xl font-semibold">{t('catalog.no-access.title')}</h1>
        <p className="text-fg-muted">{t('catalog.no-access.body')}</p>
      </SellerShell>
    );
  }
  return (
    <SellerShell session={page.session} activeId="s_stock" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <StockLocations
        initial={page.view}
        options={page.options}
        csrfToken={page.session.csrfToken}
        canEdit={page.session.permissionKeys.includes(SOURCE_EDIT_PERMISSION)}
      />
    </SellerShell>
  );
}
