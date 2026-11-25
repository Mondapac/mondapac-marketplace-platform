import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../../src/catalog/catalog-states.tsx';
import { OfferHeader } from '../../../../../src/catalog/offer-header.tsx';
import { isUuid } from '../../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../../src/server/seller-shell.tsx';
import { loadStockLevelsPage } from '../../../../../src/server/stock-levels-page.ts';
import { STOCK_EDIT_PERMISSION } from '../../../../../src/stock/levels-types.ts';
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
  // The top bar names the section; the page header names this page of the offer.
  const title = t('catalog.offers.title');
  const page = await loadStockLevelsPage(offerId);
  if (page.kind === 'unavailable') {
    return <LoadError message={t('stock.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind !== 'ok') {
    return catalogStateFor(page, 's_offers', title);
  }
  const { offer } = page;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <div className="flex flex-col gap-6">
        <OfferHeader offer={offer} back="offer" title={t('stock.levels.title')} t={t} />
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
