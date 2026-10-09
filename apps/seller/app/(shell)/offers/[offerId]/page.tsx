import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { OfferDetail } from '../../../../src/catalog/offer-detail.tsx';
import type { OfferView } from '../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.offers.title') };
}

export default async function OfferPage({
  params,
}: {
  readonly params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  if (!isUuid(offerId)) notFound();
  const t = await getTranslations();
  const title = t('catalog.offers.title');
  const page = await loadCatalogPage<OfferView>(`catalog/seller/offers/${offerId}`);
  const state = await catalogStateFor(page, 's_offers', title);
  if (state !== null || page.kind !== 'ok') return state;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <OfferDetail offer={page.body} />
    </SellerShell>
  );
}
