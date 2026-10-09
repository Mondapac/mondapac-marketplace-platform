import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { OffersTable } from '../../../src/catalog/offers-table.tsx';
import { Pager } from '../../../src/catalog/pager.tsx';
import type { OfferView, Page } from '../../../src/catalog/types.ts';
import { afterIdParam, loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.offers.title') };
}

export default async function OffersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const after = afterIdParam((await searchParams).after);
  const t = await getTranslations();
  const title = t('catalog.offers.title');
  const page = await loadCatalogPage<Page<OfferView>>(
    `catalog/seller/offers${after === undefined ? '' : `?afterId=${after}`}`,
  );
  const state = await catalogStateFor(page, 's_offers', title);
  if (state !== null || page.kind !== 'ok') return state;
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <OffersTable items={page.body.items} />
      <Pager basePath="/offers" nextAfterId={page.body.nextAfterId} />
    </SellerShell>
  );
}
