'use client';

import { useTranslations } from 'next-intl';
import type { VariantRow } from './draft-content.ts';
import type { FormField } from './types.ts';
import { previewLabels } from './variant-grid.ts';

/**
 * The read-only labels of the ticked variants (variants V2): the code of each variant and the label
 * the server will build in each language from its option names. Nothing here is typed by the seller.
 */
export function VariantLabelsPreview({
  rows,
  fields,
  axes,
  locales,
}: {
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly axes: readonly string[];
  readonly locales: readonly string[];
}) {
  const t = useTranslations();
  if (rows.length === 0 || axes.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="font-medium">{t('catalog.edit.grid.step-labels')}</h3>
      <p className="text-sm text-fg-muted">{t('catalog.edit.grid.labels-help')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-start text-sm">
          <caption className="sr-only">{t('catalog.edit.grid.labels-caption')}</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2 text-start font-medium">
                {t('catalog.edit.grid.labels-code')}
              </th>
              {locales.map((locale) => (
                <th key={locale} scope="col" className="p-2 text-start font-medium">
                  {locale}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const labels = previewLabels(fields, axes, row.options, locales);
              return (
                <tr key={row.key} className="border-t border-line">
                  <th scope="row" className="p-2 text-start font-normal">
                    {row.variantCode ?? (
                      <span className="text-fg-muted">
                        {t('catalog.edit.grid.labels-code-new')}
                      </span>
                    )}
                  </th>
                  {locales.map((locale) => (
                    <td key={locale} className="p-2">
                      {labels[locale] ?? (
                        <span className="text-fg-muted">
                          {t('catalog.edit.grid.labels-missing')}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
