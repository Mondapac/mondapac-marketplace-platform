import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../../src/catalog/catalog-states.tsx';
import { OfferHeader } from '../../../../../src/catalog/offer-header.tsx';
import { OfferPrices } from '../../../../../src/price/offer-prices.tsx';
import { PRICE_EDIT_PERMISSION } from '../../../../../src/price/types.ts';
import { isUuid } from '../../../../../src/server/catalog-page.ts';
import { loadPricesPage } from '../../../../../src/server/prices-page.ts';
import { SellerShell } from '../../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('price.title') };
}

export default async function OfferPricesPage({
  params,
}: {
  readonly params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  if (!isUuid(offerId)) notFound();
  const t = await getTranslations();
  // The top bar names the section; the page header names this page of the offer.
  const title = t('catalog.offers.title');
  const page = await loadPricesPage(offerId);
  if (page.kind === 'unavailable') {
    return <LoadError message={t('price.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind !== 'ok') {
    return catalogStateFor(page, 's_offers', title);
  }
  const { offer } = page;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <div className="flex flex-col gap-6">
        <OfferHeader offer={offer} back="offer" title={t('price.title')} t={t} />
        <OfferPrices
          offerId={offerId}
          view={page.view}
          canEdit={page.session.permissionKeys.includes(PRICE_EDIT_PERMISSION)}
          csrfToken={page.session.csrfToken}
          zone={page.zone ?? undefined}
        />
      </div>
    </SellerShell>
  );
}
