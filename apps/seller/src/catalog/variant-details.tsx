'use client';

import { Banner, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { VariantRow } from './draft-content.ts';
import { photoUrl } from './photos-section.tsx';
import {
  DIMENSION_MM_MAX,
  SIZE_KEYS,
  VARIANT_IMAGES_MAX,
  WEIGHT_GRAMS_MAX,
  problemsOfRows,
  type SizeKey,
} from './variant-fields.ts';

const SIZE_LABEL: Record<SizeKey, string> = {
  weightGrams: 'weight',
  lengthMm: 'length',
  widthMm: 'width',
  heightMm: 'height',
};

/**
 * Step 4 of the variants editor (variants V4): for each ticked variant, its barcode, shipping
 * weight and box, and the photos it picks from the product's photos. Every field is optional;
 * a problem shows under its field and the parent blocks the save until it is fixed.
 */
export function VariantDetails({
  rows,
  titleOf,
  productId,
  galleryIds,
  notices,
  onRow,
}: {
  readonly rows: readonly VariantRow[];
  readonly titleOf: (row: VariantRow) => string;
  readonly productId: string;
  /** The product's photos in the draft: the only ones a variant can pick. */
  readonly galleryIds: readonly string[];
  /** Variant ids whose barcode another product already carries (advice, not a refusal). */
  readonly notices: readonly string[];
  readonly onRow: (row: VariantRow, next: VariantRow) => void;
}) {
  const t = useTranslations();
  const problems = problemsOfRows(rows);
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="font-medium">{t('catalog.edit.grid.step-details')}</h3>
      <p className="text-sm text-fg-muted">{t('catalog.edit.grid.details-help')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('catalog.edit.grid.details-none')}</p>
      ) : null}
      {rows.map((row, index) => {
        const found = problems[index] ?? {};
        const picked = row.imageIds.filter((id) => galleryIds.includes(id));
        const full = picked.length >= VARIANT_IMAGES_MAX;
        const sizeError = (key: SizeKey): string | undefined => {
          const problem = found[key];
          return problem === undefined
            ? undefined
            : t(
                `catalog.edit.grid.problem.size.${problem === 'required' ? 'required' : 'invalid'}`,
                {
                  max: key === 'weightGrams' ? WEIGHT_GRAMS_MAX : DIMENSION_MM_MAX,
                },
              );
        };
        return (
          <fieldset
            key={row.key}
            className="flex flex-col gap-3 rounded-md border border-line p-3"
            data-testid={`variant-details-${row.key}`}
          >
            <legend className="px-1 text-sm font-medium">{titleOf(row)}</legend>
            {row.variantId !== null && notices.includes(row.variantId) ? (
              <Banner tone="info">{t('catalog.edit.grid.notice.duplicate', { count: 1 })}</Banner>
            ) : null}
            <TextField
              name={`variant.${row.key}.gtin`}
              label={t('catalog.edit.grid.gtin')}
              help={t('catalog.edit.grid.gtin-help')}
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              value={row.gtin}
              error={
                found.gtin === undefined
                  ? undefined
                  : t(`catalog.edit.grid.problem.gtin.${found.gtin}`)
              }
              onChange={(event) => onRow(row, { ...row, gtin: event.target.value })}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {SIZE_KEYS.map((key) => (
                <TextField
                  key={key}
                  name={`variant.${row.key}.${key}`}
                  label={t(`catalog.edit.grid.${SIZE_LABEL[key]}`)}
                  inputMode="numeric"
                  dir="ltr"
                  value={row[key]}
                  error={sizeError(key)}
                  onChange={(event) => onRow(row, { ...row, [key]: event.target.value })}
                />
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{t('catalog.edit.grid.photos')}</p>
              {galleryIds.length === 0 ? (
                <p className="text-sm text-fg-muted">{t('catalog.edit.grid.photos-none')}</p>
              ) : (
                <>
                  <p className="text-sm text-fg-muted" aria-live="polite">
                    {t('catalog.edit.grid.photos-help', { count: picked.length })}
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {galleryIds.map((id, number) => {
                      const place = picked.indexOf(id);
                      const on = place >= 0;
                      return (
                        <li key={id} className="relative">
                          <label className="flex cursor-pointer flex-col items-center gap-1">
                            <img
                              src={photoUrl(productId, id, 'thumb')}
                              alt={t('catalog.edit.grid.photo-alt', { number: number + 1 })}
                              className={`size-16 rounded-md object-cover ${
                                on ? 'ring-2 ring-accent' : 'opacity-70'
                              }`}
                            />
                            <input
                              type="checkbox"
                              className="size-4 accent-accent"
                              name={`variant.${row.key}.image.${id}`}
                              aria-label={t('catalog.edit.grid.photo-alt', { number: number + 1 })}
                              checked={on}
                              disabled={!on && full}
                              onChange={(event) =>
                                onRow(row, {
                                  ...row,
                                  imageIds: event.target.checked
                                    ? [...picked, id]
                                    : picked.filter((item) => item !== id),
                                })
                              }
                            />
                          </label>
                          {on ? (
                            <span className="absolute start-1 top-1 rounded bg-accent px-1 text-xs text-on-accent">
                              {place + 1}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {found.imageIds === undefined ? null : (
                <p className="text-sm text-critical-fg" role="alert">
                  {t('catalog.edit.grid.problem.images', { max: VARIANT_IMAGES_MAX })}
                </p>
              )}
            </div>
          </fieldset>
        );
      })}
    </section>
  );
}
