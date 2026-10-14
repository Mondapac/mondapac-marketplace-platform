import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
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
  const title = t('stock.levels.title');
  const page = await loadStockLevelsPage(offerId);
  if (page.kind === 'unavailable') {
    return <LoadError message={t('stock.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind !== 'ok') {
    const key = page.kind === 'no-access' ? 'no-access' : 'not-found';
    return (
      <SellerShell session={page.session} activeId="s_offers" title={title}>
        <h1 className="mb-2 text-2xl font-semibold">{t(`catalog.${key}.title`)}</h1>
        <p className="text-fg-muted">{t(`catalog.${key}.body`)}</p>
      </SellerShell>
    );
  }
  const { offer } = page;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <h1 className="mb-1 text-2xl font-semibold">{title}</h1>
      <p className="mb-4 break-words text-fg-muted">
        {offer.product.name ?? offer.product.productCode ?? offer.sellerSku}
      </p>
      <StockLevels
        offerId={offerId}
        view={page.view}
        sources={page.sources.sources}
        canEdit={page.session.permissionKeys.includes(STOCK_EDIT_PERMISSION)}
        csrfToken={page.session.csrfToken}
      />
      <p className="mt-4">
        <a className="font-medium text-link underline" href={`/offers/${offerId}`}>
          {t('stock.levels.back')}
        </a>
      </p>
    </SellerShell>
  );
}
