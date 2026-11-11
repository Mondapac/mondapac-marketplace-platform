import { LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../../src/catalog/catalog-states.tsx';
import { OfferHeader } from '../../../../../src/catalog/offer-header.tsx';
import { VariantsTable } from '../../../../../src/catalog/variants-table.tsx';
import { PRICE_EDIT_PERMISSION, PRICE_VIEW_PERMISSION } from '../../../../../src/price/types.ts';
import { EDIT_PERMISSION } from '../../../../../src/catalog/types.ts';
import { isUuid } from '../../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../../src/server/seller-shell.tsx';
import { loadVariantsPage } from '../../../../../src/server/variants-page.ts';
import { STOCK_EDIT_PERMISSION } from '../../../../../src/stock/levels-types.ts';
import { STOCK_VIEW_PERMISSION } from '../../../../../src/stock/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.variants-table.title') };
}

export default async function OfferVariantsPage({
  params,
}: {
  readonly params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  if (!isUuid(offerId)) notFound();
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t('catalog.offers.title');
  const page = await loadVariantsPage(offerId, locale, (number) =>
    t('catalog.variants-table.variant-n', { number }),
  );
  if (page.kind === 'unavailable') {
    return <LoadError message={t('price.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind !== 'ok') {
    return catalogStateFor(page, 's_offers', title);
  }
  const { permissionKeys } = page.session;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <div className="flex flex-col gap-6">
        <OfferHeader
          offer={page.offer}
          active="variants"
          canViewPrices={permissionKeys.includes(PRICE_VIEW_PERMISSION)}
          canViewStock={permissionKeys.includes(STOCK_VIEW_PERMISSION)}
          t={t}
        />
        <VariantsTable
          offerId={offerId}
          rows={page.rows}
          sources={page.sources}
          currency={page.currency}
          canEditPrice={permissionKeys.includes(PRICE_EDIT_PERMISSION)}
          canEditStock={permissionKeys.includes(STOCK_EDIT_PERMISSION)}
          units={
            page.units === null
              ? null
              : { ...page.units, canEdit: permissionKeys.includes(EDIT_PERMISSION) }
          }
          csrfToken={page.session.csrfToken}
          fileModel={page.fileModel}
        />
      </div>
    </SellerShell>
  );
}
