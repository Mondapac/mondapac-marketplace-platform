'use client';

import { Banner, Button, Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { pickLabel, variantTitle, type VariantRow } from './draft-content.ts';
import type { DraftSaved, FormField } from './types.ts';

/**
 * The variants of a platform product. A one-size product has one fixed variant and nothing to
 * edit; a configurable one lists its variants with an option per variant type, and a label in the
 * default language. This list is the simple editor; the combination grid replaces it (V3c).
 */
export function VariantsSection({
  configurable,
  rows,
  fields,
  defaultLocale,
  max,
  published,
  refused,
  onChange,
}: {
  readonly configurable: boolean;
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly defaultLocale: string;
  readonly max: number;
  /** The product has a published revision: its variant types are locked. */
  readonly published: boolean;
  readonly refused: DraftSaved['refusedFields'];
  readonly onChange: (rows: VariantRow[]) => void;
}) {
  const t = useTranslations('catalog.productForm');
  const added = useRef(0);
  const axes = fields.filter((field) => field.isVariantOption);
  const patch = (key: string, change: Partial<VariantRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  function add() {
    added.current += 1;
    onChange([
      ...rows,
      { variantId: null, key: `new-${added.current}`, state: 'new', options: {}, labels: {} },
    ]);
  }

  return (
    <Card title={t('variants')}>
      <p className="font-medium">{t(configurable ? 'model.configurable' : 'model.single')}</p>
      <p className="text-sm text-fg-muted">
        {t(configurable ? 'model.configurable-help' : 'model.single-help')}
      </p>
      <Banner tone="info">{t(published ? 'model.locked' : 'model.lock-note')}</Banner>
      {configurable ? (
        <>
          <p className="text-sm text-fg-muted">
            {t('variants-count', { count: rows.length, max })}
          </p>
          {rows.map((row, index) => (
            <div key={row.key} className="flex flex-col gap-3 border-t border-line pt-3">
              <p className="font-medium">
                {variantTitle(row, fields, defaultLocale, t('variant-n', { n: index + 1 }))}
              </p>
              {axes.map((axis) => (
                <Select
                  key={axis.code}
                  name={`variant.${row.key}.${axis.code}`}
                  label={pickLabel(axis.names, defaultLocale, axis.code)}
                  placeholder={t('attribute.unset')}
                  options={axis.options.map((option) => ({
                    value: option.code,
                    label: pickLabel(option.labels, defaultLocale, option.code),
                  }))}
                  value={row.options[axis.code] ?? ''}
                  onChange={(event) =>
                    patch(row.key, { options: { ...row.options, [axis.code]: event.target.value } })
                  }
                />
              ))}
              <TextField
                name={`variant.${row.key}.label`}
                label={t('variant-label')}
                optionalLabel={t('optional')}
                value={row.labels[defaultLocale] ?? ''}
                error={
                  refused.some((item) => item.ref === row.variantId)
                    ? t('refused-field')
                    : undefined
                }
                onChange={(event) =>
                  patch(row.key, { labels: { ...row.labels, [defaultLocale]: event.target.value } })
                }
              />
              {row.state === 'published' ? (
                <p className="text-sm text-fg-muted">{t('variant-published')}</p>
              ) : (
                <div>
                  <Button
                    variant="destructive"
                    onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
                  >
                    {t('variant-remove')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div>
            <Button variant="secondary" disabled={rows.length >= max} onClick={add}>
              {t('variant-add')}
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}
