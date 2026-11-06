'use client';

import { Banner, Button, Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { pickLabel, variantTitle, type VariantRow } from './draft-content.ts';
import { axisCandidates, secondAxisChoices } from './add-sizes.ts';
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
  axes,
  publishedAxes,
  maxAxes,
  canAddSizes,
  addSizesBlocked,
  refused,
  onChange,
  onAxes,
  onAddSizes,
}: {
  readonly configurable: boolean;
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly defaultLocale: string;
  readonly max: number;
  /** The product has a published revision: its variant types are locked. */
  readonly published: boolean;
  /** The types this product varies on; null while its draft names none (it then varies on all). */
  readonly axes: readonly string[] | null;
  /** The types the published revision varies on; null while it is Simple or nothing is published. */
  readonly publishedAxes: readonly string[] | null;
  /** The Market's cap on the types a product varies on. */
  readonly maxAxes: number;
  /** A Simple product that can still change: Add sizes is offered. */
  readonly canAddSizes: boolean;
  /** There are edits not saved: Add sizes reloads the product, so they must be saved first. */
  readonly addSizesBlocked: boolean;
  readonly refused: DraftSaved['refusedFields'];
  readonly onChange: (rows: VariantRow[]) => void;
  readonly onAxes: (axes: string[]) => void;
  readonly onAddSizes: () => void;
}) {
  const t = useTranslations('catalog.productForm');
  const added = useRef(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState('');
  const shown = fields.filter(
    (field) => field.isVariantOption && (axes === null || axes.includes(field.code)),
  );
  // A published product with one type may add a second once (catalog design 4.2a).
  const choices = secondAxisChoices(publishedAxes, fields, maxAxes);
  const secondCode =
    publishedAxes?.length === 1 ? axes?.find((axis) => !publishedAxes.includes(axis)) : undefined;
  const second = fields.find((field) => field.code === secondCode);
  const nameOf = (field: FormField) => pickLabel(field.names, defaultLocale, field.code);

  function addSecond() {
    if (picked === '') return;
    onAxes(
      axisCandidates(fields)
        .map((field) => field.code)
        .filter((code) => code === picked || (axes ?? []).includes(code)),
    );
    setPicking(false);
    setPicked('');
  }

  function dropSecond() {
    if (secondCode === undefined) return;
    onChange(
      rows.map((row) => ({
        ...row,
        options: Object.fromEntries(
          Object.entries(row.options).filter(([axis]) => axis !== secondCode),
        ),
      })),
    );
    onAxes((axes ?? []).filter((axis) => axis !== secondCode));
  }

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
              {shown.map((axis) => (
                <Select
                  key={axis.code}
                  name={`variant.${row.key}.${axis.code}`}
                  label={pickLabel(axis.names, defaultLocale, axis.code)}
                  placeholder={t('attribute.unset')}
                  options={axis.options.map((option) => ({
                    value: option.code,
                    label: pickLabel(option.labels, defaultLocale, option.code),
                  }))}
                  required={axis.code === secondCode}
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
      {canAddSizes ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <p className="text-sm text-fg-muted">{t('addSizes.card-help')}</p>
          <div>
            <Button variant="secondary" disabled={addSizesBlocked} onClick={onAddSizes}>
              {t('addSizes.start')}
            </Button>
            {addSizesBlocked ? (
              <p className="mt-1 text-sm text-fg-muted">{t('addSizes.save-first')}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {configurable && second === undefined && choices.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="font-medium">{t('second.title')}</h3>
          <p className="text-sm text-fg-muted">{t('second.help')}</p>
          {picking ? (
            <div className="flex flex-col gap-3">
              <Select
                name="secondAxis"
                label={t('second.pick')}
                placeholder={t('second.choose')}
                options={choices.map((field) => ({ value: field.code, label: nameOf(field) }))}
                value={picked}
                onChange={(event) => setPicked(event.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => setPicking(false)}>
                  {t('second.cancel')}
                </Button>
                <Button disabled={picked === ''} onClick={addSecond}>
                  {t('second.add')}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button variant="secondary" onClick={() => setPicking(true)}>
                {t('second.start')}
              </Button>
            </div>
          )}
        </section>
      ) : null}
      {configurable && second !== undefined ? (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="font-medium">{t('second.values-title', { type: nameOf(second) })}</h3>
          <Banner tone="info">{t('second.review')}</Banner>
          <p className="text-sm text-fg-muted">
            {t('second.values-help', { type: nameOf(second).toLocaleLowerCase(defaultLocale) })}
          </p>
          <div>
            <Button variant="secondary" onClick={dropSecond}>
              {t('second.remove')}
            </Button>
          </div>
        </section>
      ) : null}
    </Card>
  );
}
