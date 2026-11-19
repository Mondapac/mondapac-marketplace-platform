import { BackLink, Banner, Card } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { SuggestProductPicker } from '../../../../src/catalog/suggest-product-picker.tsx';
import { SuggestValueForm } from '../../../../src/catalog/suggest-value-form.tsx';
import {
  productDraftName,
  SUGGESTING_STATUSES,
  suggestableFields,
} from '../../../../src/catalog/suggestion-fields.ts';
import {
  EDIT_PERMISSION,
  type Page,
  type ProductListItem,
  type ProductOptions,
  type ProductView,
} from '../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.suggestions.new.title') };
}

const FIELD_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export default async function NewValueSuggestionPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const productId =
    typeof query.product === 'string' && isUuid(query.product) ? query.product : undefined;
  const fieldCode =
    typeof query.field === 'string' && FIELD_CODE.test(query.field) ? query.field : undefined;
  const t = await getTranslations();
  const title = t('catalog.suggestions.new.title');
  const back = <BackLink href="/value-suggestions" label={t('catalog.suggestions.back')} />;

  if (productId === undefined) {
    // Step 1: the product. The newest 50 are offered; for an older one the product page links here
    // with its id ("Suggest a value" beside "Edit product").
    const page = await loadCatalogPage<Page<ProductListItem>>(
      'catalog/seller/products?limit=50',
      EDIT_PERMISSION,
    );
    const state = await catalogStateFor(page, 's_suggestions', title);
    if (state !== null || page.kind !== 'ok') return state;
    const products = page.body.items.filter((item) => SUGGESTING_STATUSES.has(item.status));
    return (
      <SellerShell session={page.session} activeId="s_suggestions" title={title}>
        <div className="mb-4">{back}</div>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <div className="max-w-(--mp-size-form-max)">
          <Card>
            {products.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('catalog.suggestions.new.no-products')}</p>
            ) : (
              <SuggestProductPicker
                field={fieldCode}
                products={products.map((item) => ({
                  id: item.productId,
                  label:
                    item.draftName === null
                      ? item.productCode
                      : `${item.draftName} (${item.productCode})`,
                }))}
              />
            )}
          </Card>
        </div>
      </SellerShell>
    );
  }

  // Step 2: the field and the value, for the chosen product.
  const page = await loadCatalogPage<ProductView>(
    `catalog/seller/products/${productId}`,
    EDIT_PERMISSION,
  );
  const state = await catalogStateFor(page, 's_suggestions', title);
  if (state !== null || page.kind !== 'ok') return state;
  const options = await loadCatalogPage<ProductOptions>(
    'catalog/seller/products/options',
    EDIT_PERMISSION,
  );
  if (options.kind !== 'ok') return catalogStateFor(options, 's_suggestions', title);
  const product = page.body;
  const fields = suggestableFields(product, options.body.locales.default);
  const name = productDraftName(product, options.body.locales.default);
  return (
    <SellerShell session={page.session} activeId="s_suggestions" title={title}>
      <div className="mb-4">{back}</div>
      <h1 className="mb-1 text-2xl font-semibold">{title}</h1>
      <p className="mb-4 text-sm text-fg-muted" data-testid="chosen-product">
        {t('catalog.suggestions.new.for', { product: name ?? product.productCode })}{' '}
        <a
          className="text-link underline"
          href={`/value-suggestions/new${fieldCode === undefined ? '' : `?field=${fieldCode}`}`}
        >
          {t('catalog.suggestions.new.change-product')}
        </a>
      </p>
      <div className="max-w-(--mp-size-form-max)">
        <Card>
          {!SUGGESTING_STATUSES.has(product.status) ? (
            <Banner tone="info">{t('catalog.edit.attribute.suggest.error.not-editable')}</Banner>
          ) : fields.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('catalog.suggestions.new.no-fields')}</p>
          ) : (
            <SuggestValueForm
              productId={product.productId}
              fields={fields}
              initialField={fieldCode}
              csrfToken={page.session.csrfToken}
            />
          )}
        </Card>
      </div>
    </SellerShell>
  );
}
