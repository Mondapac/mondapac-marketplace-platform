import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../../src/catalog/catalog-states.tsx';
import { OfferEditForm } from '../../../../../src/catalog/offer-edit-form.tsx';
import {
  EDIT_PERMISSION,
  type OfferView,
  type ProductOptions,
} from '../../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.offer-edit.title') };
}

export default async function EditOfferPage({
  params,
}: {
  readonly params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  if (!isUuid(offerId)) notFound();
  const t = await getTranslations();
  const title = t('catalog.offer-edit.title');
  const page = await loadCatalogPage<OfferView>(
    `catalog/seller/offers/${offerId}`,
    EDIT_PERMISSION,
  );
  const state = await catalogStateFor(page, 's_offers', title);
  if (state !== null || page.kind !== 'ok') return state;
  if (page.body.status === 'published') {
    return (
      <SellerShell session={page.session} activeId="s_offers" title={title}>
        <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('catalog.offer-edit.error.not-editable')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href={`/offers/${offerId}`}>
            {t('catalog.offer-edit.back')}
          </a>
        </p>
      </SellerShell>
    );
  }
  const options = await loadCatalogPage<ProductOptions>(
    'catalog/seller/products/options',
    EDIT_PERMISSION,
  );
  if (options.kind !== 'ok') return catalogStateFor(options, 's_offers', title);
  return (
    <SellerShell session={page.session} activeId="s_offers" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{page.body.sellerSku}</h1>
      <div className="max-w-(--mp-size-form-max)">
        <OfferEditForm
          offer={page.body}
          options={options.body}
          csrfToken={page.session.csrfToken}
        />
      </div>
    </SellerShell>
  );
}
