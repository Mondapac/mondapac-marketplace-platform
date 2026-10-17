import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../../src/catalog/catalog-states.tsx';
import { OfferHeader } from '../../../../../src/catalog/offer-header.tsx';
import { isUuid } from '../../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../../src/server/seller-shell.tsx';
import { loadStockLevelsPage } from '../../../../../src/server/stock-levels-page.ts';
import { STOCK_EDIT_PERMISSION } from '../../../../../src/stock/levels-types.ts';
import { PRICE_VIEW_PERMISSION } from '../../../../../src/price/types.ts';
import { STOCK_VIEW_PERMISSION } from '../../../../../src/stock/types.ts';
import { StockLevels } from '../../../../../src/stock/stock-levels.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('stock.levels.title') };
}

export default async function OfferStockPage({
  params,
}: {
  readonly params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  if (!isUuid(offerId)) notFound();
  const t = await getTranslations();
  // The top bar names the section, as on the offer's other tabs; the tab names this page.
  const title = t('catalog.offers.title');
  const page = await loadStockLevelsPage(offerId);
  if (page.kind === 'unavailable') {
    return <LoadError message={t('stock.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind !== 'ok') {
    return catalogStateFor(page, 's_offers', title);
  }
  const { offer } = page;
  const { permissionKeys } = page.session;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <div className="flex flex-col gap-6">
        <OfferHeader
          offer={offer}
          active="stock"
          canViewPrices={permissionKeys.includes(PRICE_VIEW_PERMISSION)}
          canViewStock={permissionKeys.includes(STOCK_VIEW_PERMISSION)}
          t={t}
        />
        <StockLevels
          offerId={offerId}
          view={page.view}
          sources={page.sources.sources}
          canEdit={page.session.permissionKeys.includes(STOCK_EDIT_PERMISSION)}
          csrfToken={page.session.csrfToken}
        />
      </div>
    </SellerShell>
  );
}
