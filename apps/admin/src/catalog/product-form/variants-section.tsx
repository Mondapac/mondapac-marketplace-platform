'use client';

import { Banner, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { VariantRow } from './draft-content.ts';
import type { DraftSaved, FormField } from './types.ts';
import { VariantGridSection as VariantGrid } from './variant-grid-section.tsx';

/**
 * The variants of a platform product. A one-size product has one fixed variant and nothing to
 * edit; a configurable one lists its variants with an option per variant type, and a label in the
 * default language. A configurable product uses the combination grid (V3c).
 */
export function VariantsSection({
  configurable,
  rows,
  fields,
  axes,
  defaultLocale,
  max,
  published,
  refused,
  productId,
  galleryIds,
  notices,
  onChange,
}: {
  readonly configurable: boolean;
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly axes: readonly string[];
  readonly defaultLocale: string;
  readonly max: number;
  /** The product has a published revision: its variant types are locked. */
  readonly published: boolean;
  readonly refused: DraftSaved['refusedFields'];
  readonly productId: string;
  readonly galleryIds: readonly string[];
  readonly notices: readonly string[];
  readonly onChange: (change: { rows: VariantRow[]; axes: string[] }) => void;
}) {
  const t = useTranslations('catalog.productForm');

  return (
    <Card title={t('variants')}>
      <p className="font-medium">{t(configurable ? 'model.configurable' : 'model.single')}</p>
      <p className="text-sm text-fg-muted">
        {t(configurable ? 'model.configurable-help' : 'model.single-help')}
      </p>
      <Banner tone="info">{t(published ? 'model.locked' : 'model.lock-note')}</Banner>
      {configurable ? (
        <VariantGrid
          rows={rows}
          fields={fields}
          axes={axes}
          locked={published}
          defaultLocale={defaultLocale}
          max={max}
          refused={refused}
          productId={productId}
          galleryIds={galleryIds}
          notices={notices}
          onChange={onChange}
        />
      ) : null}
    </Card>
  );
}
