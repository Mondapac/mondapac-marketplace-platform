'use client';

import { Button, Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { pickLabel, variantTitle, type VariantRow } from './draft-content.ts';
import type { DraftSaved, FormField } from './types.ts';

/** The variants of a configurable product: option values and labels per variant, add and remove. */
export function VariantsSection({
  rows,
  fields,
  locales,
  defaultLocale,
  max,
  refused,
  onChange,
}: {
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly max: number;
  readonly refused: DraftSaved['refusedFields'];
  readonly onChange: (rows: VariantRow[]) => void;
}) {
  const t = useTranslations();
  const axes = fields.filter((field) => field.isVariantOption);
  const patch = (key: string, change: Partial<VariantRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  function add() {
    const key = `new-${Date.now().toString(36)}-${rows.length}`;
    onChange([...rows, { variantId: null, key, state: 'new', options: {}, labels: {} }]);
  }

  return (
    <Card title={t('catalog.edit.variants')}>
      <p className="text-sm text-fg-muted">
        {t('catalog.product.variants-count', { count: rows.length, max })}
      </p>
      {rows.map((row, index) => (
        <div key={row.key} className="flex flex-col gap-3 border-t border-line pt-3">
          <p className="font-medium">
            {variantTitle(
              row,
              fields,
              defaultLocale,
              t('catalog.edit.variant-n', { n: index + 1 }),
            )}
          </p>
          {axes.map((axis) => (
            <Select
              key={axis.code}
              name={`variant.${row.key}.${axis.code}`}
              label={pickLabel(axis.names, defaultLocale, axis.code)}
              placeholder={t('catalog.edit.attribute.unset')}
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
          {locales.map((locale) => (
            <TextField
              key={locale}
              name={`variant.${row.key}.label.${locale}`}
              label={t('catalog.edit.variant-label', { locale })}
              optionalLabel={t('catalog.create.optional')}
              value={row.labels[locale] ?? ''}
              error={
                refused.some((item) => item.ref === row.variantId && item.locale === locale)
                  ? t('catalog.edit.refused-field')
                  : undefined
              }
              onChange={(event) =>
                patch(row.key, { labels: { ...row.labels, [locale]: event.target.value } })
              }
            />
          ))}
          {row.state === 'published' ? (
            <p className="text-sm text-fg-muted">{t('catalog.edit.variant-published')}</p>
          ) : (
            <div>
              <Button
                variant="destructive"
                onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
              >
                {t('catalog.edit.variant-remove')}
              </Button>
            </div>
          )}
        </div>
      ))}
      <div>
        <Button variant="secondary" disabled={rows.length >= max} onClick={add}>
          {t('catalog.edit.variant-add')}
        </Button>
      </div>
    </Card>
  );
}
