import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { OfferDetail } from '../../../../src/catalog/offer-detail.tsx';
import { EDIT_PERMISSION, VIEW_PERMISSION } from '../../../../src/catalog/types.ts';
import { VariantsTable } from '../../../../src/catalog/variants-table.tsx';
import { loadActiveShelves } from '../../../../src/server/category-proposals-page.ts';
import { isUuid } from '../../../../src/server/catalog-page.ts';
import { PRICE_EDIT_PERMISSION } from '../../../../src/price/types.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { loadVariantsPage } from '../../../../src/server/variants-page.ts';
import { STOCK_EDIT_PERMISSION } from '../../../../src/stock/levels-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.offers.title') };
}

/**
 * The one page of an offer (Offer page PR 3): its details and, in the same page, the sizes with
 * their prices and stock. The offer read needs the catalog view key, so the page does too.
 */
export default async function OfferPage({
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
  if (page.kind !== 'ok') return catalogStateFor(page, 's_offers', title);
  const keys = page.session.permissionKeys;
  if (!keys.includes(VIEW_PERMISSION)) {
    return catalogStateFor({ kind: 'no-access', session: page.session }, 's_offers', title);
  }
  const shelves = await loadActiveShelves(keys, locale);
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <OfferDetail
        offer={page.offer}
        canEdit={keys.includes(EDIT_PERMISSION)}
        csrfToken={page.session.csrfToken}
        shelves={shelves}
        sizes={
          <VariantsTable
            offerId={offerId}
            rows={page.rows}
            sources={page.sources}
            currency={page.currency}
            canEditPrice={keys.includes(PRICE_EDIT_PERMISSION)}
            canEditStock={keys.includes(STOCK_EDIT_PERMISSION)}
            units={
              page.units === null
                ? null
                : { ...page.units, canEdit: keys.includes(EDIT_PERMISSION) }
            }
            csrfToken={page.session.csrfToken}
            sizeRequests={page.sizeRequests}
            fileModel={page.fileModel}
          />
        }
      />
    </SellerShell>
  );
}
