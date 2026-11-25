import { Card, LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { OfferDetail } from '../../../../src/catalog/offer-detail.tsx';
import { EDIT_PERMISSION, type OfferView } from '../../../../src/catalog/types.ts';
import { VariantsTable } from '../../../../src/catalog/variants-table.tsx';
import { loadActiveShelves } from '../../../../src/server/category-proposals-page.ts';
import { isUuid, loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { loadOfferSizes } from '../../../../src/server/offer-sizes.ts';
import { canEstimateReceive } from '../../../../src/price/receive-permissions.ts';
import { PRICE_EDIT_PERMISSION } from '../../../../src/price/types.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { STOCK_EDIT_PERMISSION } from '../../../../src/stock/levels-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.offers.title') };
}

/**
 * The one page of an offer (Offer page PR 3): its details and, on the same page, the sizes with
 * their prices and stock. The offer read is the page's gate (it needs the catalog view key); when
 * only the prices, stock or sizes cannot be read, the offer still shows and the sizes card says so.
 */
export default async function OfferPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ offerId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { offerId } = await params;
  // "Sell this" opens a new draft with `?new=1`: the cursor starts on the first price.
  const isNew = (await searchParams).new === '1';
  if (!isUuid(offerId)) notFound();
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t('catalog.offers.title');
  const page = await loadCatalogPage<OfferView>(`catalog/seller/offers/${offerId}`);
  const state = await catalogStateFor(page, 's_offers', title);
  if (state !== null || page.kind !== 'ok') return state;
  const keys = page.session.permissionKeys;
  const [sizes, shelves] = await Promise.all([
    loadOfferSizes(page.body, keys, locale, (number) =>
      t('catalog.variants-table.variant-n', { number }),
    ),
    loadActiveShelves(keys, locale),
  ]);
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <OfferDetail
        offer={page.body}
        canEdit={keys.includes(EDIT_PERMISSION)}
        csrfToken={page.session.csrfToken}
        shelves={shelves}
        sizes={
          sizes === 'unavailable' ? (
            <div id="sizes" className="scroll-mt-4">
              <Card title={t('catalog.variants-table.title')}>
                <LoadError
                  message={t('catalog.variants-table.unavailable')}
                  retryLabel={t('load.retry')}
                />
              </Card>
            </div>
          ) : (
            <VariantsTable
              offerId={offerId}
              rows={sizes.rows}
              sources={sizes.sources}
              currency={sizes.currency}
              canEditPrice={keys.includes(PRICE_EDIT_PERMISSION)}
              canEditStock={keys.includes(STOCK_EDIT_PERMISSION)}
              units={
                sizes.units === null
                  ? null
                  : { ...sizes.units, canEdit: keys.includes(EDIT_PERMISSION) }
              }
              csrfToken={page.session.csrfToken}
              sizeRequests={sizes.sizeRequests}
              fileModel={sizes.fileModel}
              canEstimate={canEstimateReceive(keys)}
              focusPrice={isNew}
            />
          )
        }
      />
    </SellerShell>
  );
}
