import { Badge } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { FieldList } from './field-list.tsx';
import { formatInstant, known, PRODUCT_STATUSES } from './format.ts';
import type { ProductView, RevisionView } from './types.ts';

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function Revision({
  t,
  heading,
  revision,
}: {
  readonly t: Translate;
  readonly heading: string;
  readonly revision: RevisionView;
}) {
  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="mb-3 text-lg font-semibold">{heading}</h2>
      <FieldList
        rows={[
          { label: t('catalog.revision.number'), value: String(revision.revisionNo) },
          { label: t('catalog.revision.submitted'), value: formatInstant(revision.submittedAt) },
          {
            label: t('catalog.revision.author'),
            value: t(
              `catalog.revision.author-kind.${known(revision.authorKind, ['seller', 'admin'])}`,
            ),
          },
          revision.sensitive
            ? { label: t('catalog.revision.sensitive'), value: t('catalog.revision.sensitive-yes') }
            : { label: t('catalog.revision.sensitive'), value: null },
        ]}
      />
    </section>
  );
}

/** One product of the seller, read only: state, variants and the revisions in play. */
export async function ProductDetail({ product }: { readonly product: ProductView }) {
  const t = await getTranslations();
  const status = known(product.status, PRODUCT_STATUSES);
  const active = product.variants.filter((variant) => variant.state !== 'retired').length;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{product.productCode}</h1>
        <Badge tone="neutral">{t(`catalog.products.status.${status}`)}</Badge>
        {product.pending !== null ? (
          <Badge tone="attention">{t('catalog.products.pending')}</Badge>
        ) : null}
      </div>
      <FieldList
        rows={[
          { label: t('catalog.products.col.code'), value: product.productCode },
          { label: t('catalog.product.type'), value: product.typeCode },
          {
            label: t('catalog.product.variants'),
            value: t('catalog.product.variants-count', { count: active, max: product.maxVariants }),
          },
          { label: t('catalog.col.changed'), value: formatInstant(product.lastChangedAt) },
          { label: t('catalog.product.created'), value: formatInstant(product.createdAt) },
          {
            label: t('catalog.product.working-copy'),
            value:
              product.workingCopy === null
                ? null
                : t('catalog.product.saved-at', {
                    when: formatInstant(product.workingCopy.lastSavedAt),
                  }),
          },
        ]}
      />
      {product.pending !== null ? (
        <Revision
          t={t}
          heading={t('catalog.product.pending-revision')}
          revision={product.pending}
        />
      ) : null}
      {product.published !== null ? (
        <Revision
          t={t}
          heading={t('catalog.product.published-revision')}
          revision={product.published}
        />
      ) : null}
      <p>
        <a className="font-medium text-link underline" href="/products">
          {t('catalog.products.back')}
        </a>
      </p>
    </div>
  );
}
