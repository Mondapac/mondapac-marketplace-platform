'use client';

import { Banner, Button, Card, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { axisCandidates, secondAxisChoices } from './add-sizes.ts';
import { pickLabel, variantTitle, type VariantRow } from './draft-content.ts';
import type { DraftSaved, FormField } from './types.ts';
import { VariantGridSection as VariantGrid } from './variant-grid-section.tsx';

/**
 * The variants of a platform product. A one-size product has one fixed variant and nothing to
 * edit (it can be given sizes once, "Add sizes"); a configurable one uses the combination grid
 * (V3c). A published product with one type may add a second type once (catalog design 4.2a).
 */
export function VariantsSection({
  configurable,
  rows,
  fields,
  axes,
  defaultLocale,
  max,
  published,
  publishedAxes,
  maxAxes,
  canAddSizes,
  addSizesBlocked,
  refused,
  productId,
  galleryIds,
  notices,
  onChange,
  onAddSizes,
}: {
  readonly configurable: boolean;
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly axes: readonly string[];
  readonly defaultLocale: string;
  readonly max: number;
  /** The product has a published revision: its variant types are locked. */
  readonly published: boolean;
  /** The types the published revision varies on; null while it is Simple or nothing is published. */
  readonly publishedAxes: readonly string[] | null;
  /** The Market's cap on the types a product varies on. */
  readonly maxAxes: number;
  /** A Simple product that can still change: Add sizes is offered. */
  readonly canAddSizes: boolean;
  /** There are edits not saved: Add sizes reloads the product, so they must be saved first. */
  readonly addSizesBlocked: boolean;
  readonly refused: DraftSaved['refusedFields'];
  readonly productId: string;
  readonly galleryIds: readonly string[];
  readonly notices: readonly string[];
  readonly onChange: (change: { rows: VariantRow[]; axes: string[] }) => void;
  readonly onAddSizes: () => void;
}) {
  const t = useTranslations('catalog.productForm');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState('');
  // The second type being added sits outside the grid, which keeps the published type only.
  const secondEligible = configurable && publishedAxes?.length === 1;
  const secondCode = secondEligible
    ? axes.find((axis) => !publishedAxes.includes(axis))
    : undefined;
  const second = fields.find((field) => field.code === secondCode);
  const gridAxes = secondEligible ? axes.filter((axis) => axis !== secondCode) : axes;
  const choices = secondEligible ? secondAxisChoices(publishedAxes, fields, maxAxes) : [];
  const nameOf = (field: FormField) => pickLabel(field.names, defaultLocale, field.code);

  function addSecond() {
    if (picked === '') return;
    onChange({
      rows: [...rows],
      axes: axisCandidates(fields)
        .map((field) => field.code)
        .filter((code) => code === picked || axes.includes(code)),
    });
    setPicking(false);
    setPicked('');
  }

  function dropSecond() {
    if (secondCode === undefined) return;
    onChange({
      rows: rows.map((row) => ({
        ...row,
        options: Object.fromEntries(
          Object.entries(row.options).filter(([axis]) => axis !== secondCode),
        ),
      })),
      axes: axes.filter((axis) => axis !== secondCode),
    });
  }

  function setSecondValue(key: string, value: string) {
    if (second === undefined) return;
    onChange({
      rows: rows.map((row) =>
        row.key === key ? { ...row, options: { ...row.options, [second.code]: value } } : row,
      ),
      axes: [...axes],
    });
  }

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
          axes={gridAxes}
          locked={published}
          defaultLocale={defaultLocale}
          max={max}
          refused={refused}
          productId={productId}
          galleryIds={galleryIds}
          notices={notices}
          onChange={(change) =>
            onChange({
              rows: change.rows,
              axes: secondCode === undefined ? change.axes : [...change.axes, secondCode],
            })
          }
        />
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
      {secondEligible && second === undefined && choices.length > 0 ? (
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
      {second !== undefined ? (
        <section className="flex flex-col gap-3 border-t border-line pt-3">
          <h3 className="font-medium">{t('second.values-title', { type: nameOf(second) })}</h3>
          <Banner tone="info">{t('second.review')}</Banner>
          <p className="text-sm text-fg-muted">
            {t('second.values-help', { type: nameOf(second).toLocaleLowerCase(defaultLocale) })}
          </p>
          {rows.map((row, index) => (
            <div key={row.key} className="flex flex-col gap-2">
              <p className="font-medium">
                {variantTitle(row, fields, defaultLocale, t('variant-n', { n: index + 1 }))}
              </p>
              <Select
                name={`variant.${row.key}.${second.code}`}
                label={nameOf(second)}
                placeholder={t('attribute.unset')}
                options={second.options.map((option) => ({
                  value: option.code,
                  label: pickLabel(option.labels, defaultLocale, option.code),
                }))}
                required
                value={row.options[second.code] ?? ''}
                onChange={(event) => setSecondValue(row.key, event.target.value)}
              />
            </div>
          ))}
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
