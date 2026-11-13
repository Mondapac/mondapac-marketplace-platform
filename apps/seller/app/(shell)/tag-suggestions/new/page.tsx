import { BackLink, EmptyState, LinkButton } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import {
  productDraftName,
  SUGGESTING_STATUSES,
} from '../../../../src/catalog/suggestion-fields.ts';
import { SuggestTagForm, TAG_LABEL_MAX } from '../../../../src/catalog/suggest-tag-form.tsx';
import {
  EDIT_PERMISSION,
  type OwnTopicSuggestionList,
  type Page,
  type ProductListItem,
  type ProductView,
} from '../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.tagSuggestions.new.title') };
}

const ACTIVE = 's_tag_suggestions';

/** The language of a locale tag in words ("Australian English"); the tag itself when unknown. */
function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export default async function NewTagSuggestionPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const productId =
    typeof query.product === 'string' && isUuid(query.product) ? query.product : undefined;
  // Plain text only, trimmed to what the form takes; the form shows it as the field's value.
  const label =
    typeof query.label === 'string' ? query.label.trim().slice(0, TAG_LABEL_MAX) : undefined;
  const t = await getTranslations();
  const title = t('catalog.tagSuggestions.new.title');

  // Sending needs the edit permission; the list read gives the counter and the default language.
  const products = await loadCatalogPage<Page<ProductListItem>>(
    'catalog/seller/products?limit=50',
    EDIT_PERMISSION,
  );
  const state = await catalogStateFor(products, ACTIVE, title);
  if (state !== null || products.kind !== 'ok') return state;
  const list = await loadCatalogPage<OwnTopicSuggestionList>(
    'catalog/seller/topic-suggestions?limit=1',
  );
  if (list.kind !== 'ok') return catalogStateFor(list, ACTIVE, title);
  const choices = products.body.items
    .filter((item) => SUGGESTING_STATUSES.has(item.status))
    .map((item) => ({
      id: item.productId,
      label: item.draftName === null ? item.productCode : `${item.draftName} (${item.productCode})`,
    }));
  // A product beyond the newest 50 (the product form links here with its id) is read on its own.
  if (productId !== undefined && !choices.some((choice) => choice.id === productId)) {
    const one = await loadCatalogPage<ProductView>(
      `catalog/seller/products/${productId}`,
      EDIT_PERMISSION,
    );
    if (one.kind === 'ok' && SUGGESTING_STATUSES.has(one.body.status)) {
      const name = productDraftName(one.body, list.body.locales.default);
      choices.unshift({
        id: one.body.productId,
        label: name === null ? one.body.productCode : `${name} (${one.body.productCode})`,
      });
    }
  }
  return (
    <SellerShell session={products.session} activeId={ACTIVE} title={title}>
      <div className="mb-4">
        <BackLink href="/tag-suggestions" label={t('catalog.tagSuggestions.back')} />
      </div>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      {choices.length === 0 ? (
        <EmptyState
          size="page"
          icon="package"
          title={t('catalog.tagSuggestions.new.no-products.title')}
          body={t('catalog.tagSuggestions.new.no-products.body')}
          action={
            <LinkButton href="/products/new">
              {t('catalog.tagSuggestions.new.no-products.action')}
            </LinkButton>
          }
        />
      ) : (
        <>
          <p className="mb-4 max-w-(--mp-size-form-max) text-sm text-fg-muted">
            {t('catalog.tagSuggestions.new.intro')}
          </p>
          <div className="max-w-(--mp-size-form-max)">
            <SuggestTagForm
              products={choices}
              initialProduct={productId}
              initialLabel={label}
              language={languageName(list.body.locales.default)}
              openCount={list.body.openCount}
              maxOpen={list.body.maxOpen}
              csrfToken={products.session.csrfToken}
            />
          </div>
        </>
      )}
    </SellerShell>
  );
}
