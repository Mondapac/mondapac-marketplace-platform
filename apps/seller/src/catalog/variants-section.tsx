'use client';

import { Banner, Button, Card, CheckboxRow, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { NO_VARIANT_FIELDS, pickLabel, variantTitle, type VariantRow } from './draft-content.ts';
import { secondAxisChoices } from './add-sizes.ts';
import { SecondAxisStep } from './second-axis-step.tsx';
import { VariantDetails } from './variant-details.tsx';
import type { FormField } from './types.ts';
import {
  activeOptionsOf,
  axisCandidates,
  combinationTitle,
  combinationsOf,
  nearLimit,
  rowOf,
  type Combination,
} from './variant-grid.ts';

/** The most axes a product varies on (decision t12); the server enforces the Market's limit. */
const MAX_AXES = 2;

type Pending =
  | { readonly kind: 'axes'; readonly axes: readonly string[] }
  | { readonly kind: 'drop'; readonly rows: readonly VariantRow[]; readonly then: () => void };

/**
 * The variant grid editor of a configurable product (variants V3): 1. choose what the product
 * varies on (one or two of the feature set's variant attributes), 2. choose the active options of
 * each, 3. tick the combinations that are sold. A partial grid is fine. A ticked combination is a
 * variant row; the server builds its label and code. After the first publish the axes are locked.
 */
export function VariantsSection({
  rows,
  fields,
  axes,
  locked,
  publishedAxes,
  maxAxes,
  review,
  defaultLocale,
  max,
  productId,
  galleryIds,
  notices,
  onChange,
}: {
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly axes: readonly string[];
  /** The product was published: its axes stay as they are (decision t3). */
  readonly locked: boolean;
  /** The types the published revision varies on; null while it is Simple or nothing is published. */
  readonly publishedAxes: readonly string[] | null;
  /** The Market's cap on the types a product varies on. */
  readonly maxAxes: number;
  /** Adding a second type waits for review (the product's sensitive fields include `axis-added`). */
  readonly review: boolean;
  readonly defaultLocale: string;
  readonly max: number;
  readonly productId: string;
  /** The product's photos in the draft, for the photo picks of each variant. */
  readonly galleryIds: readonly string[];
  /** Variant ids whose barcode another product carries (advice from the last save). */
  readonly notices: readonly string[];
  readonly onChange: (change: { rows: VariantRow[]; axes: string[] }) => void;
}) {
  const t = useTranslations();
  const added = useRef(0);
  const candidates = axisCandidates(fields);
  const [active, setActive] = useState<Record<string, string[]>>(() => activeOptionsOf(rows, axes));
  const [pending, setPending] = useState<Pending | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  const combos = combinationsOf(fields, axes, active);
  const ticked = (combo: Combination) => rowOf(rows, combo, axes);
  const full = rows.length >= max;
  const nameOf = (field: FormField) => pickLabel(field.names, defaultLocale, field.code);
  const titleOf = (options: Readonly<Record<string, string>>) =>
    combinationTitle(fields, axes, options, defaultLocale);

  function ask(dropped: readonly VariantRow[], then: () => void) {
    // A removal of a variant the server already knows (it may hold prices and stock) is confirmed;
    // a row only ticked in this form just goes.
    if (dropped.some((row) => row.state !== 'new')) {
      setPending({ kind: 'drop', rows: dropped, then });
    } else then();
  }

  function setAxes(next: string[]) {
    const apply = () => {
      setActive((current) => Object.fromEntries(next.map((axis) => [axis, current[axis] ?? []])));
      setPending(null);
      onChange({ rows: [], axes: next });
    };
    if (rows.length > 0) setPending({ kind: 'axes', axes: next });
    else apply();
  }

  function toggleAxis(code: string, on: boolean) {
    setAxes(
      on
        ? candidates
            .map((field) => field.code)
            .filter((item) => item === code || axes.includes(item))
        : axes.filter((item) => item !== code),
    );
  }

  function toggleOption(axis: string, code: string, on: boolean) {
    const list = on
      ? [...(active[axis] ?? []), code]
      : (active[axis] ?? []).filter((c) => c !== code);
    const dropped = on ? [] : rows.filter((row) => row.options[axis] === code);
    const apply = () => {
      setActive({ ...active, [axis]: list });
      setPending(null);
      onChange({ rows: rows.filter((row) => !dropped.includes(row)), axes: [...axes] });
    };
    ask(dropped, apply);
  }

  function toggleCombo(combo: Combination, on: boolean) {
    const found = ticked(combo);
    if (on) {
      if (found !== undefined || full) return;
      added.current += 1;
      const row: VariantRow = {
        variantId: null,
        key: `new-${added.current}`,
        state: 'new',
        options: combo.options,
        labels: {},
        ...NO_VARIANT_FIELDS,
      };
      onChange({ rows: [...rows, row], axes: [...axes] });
    } else if (found !== undefined) {
      ask([found], () => {
        setPending(null);
        onChange({ rows: rows.filter((row) => row !== found), axes: [...axes] });
      });
    }
  }

  const tick = (combo: Combination) => {
    const on = ticked(combo) !== undefined;
    return (
      <input
        type="checkbox"
        className="size-4 accent-accent"
        aria-label={titleOf(combo.options)}
        checked={on}
        disabled={!on && full}
        onChange={(event) => toggleCombo(combo, event.target.checked)}
      />
    );
  };

  // A published product with one type may add a second once (catalog design 4.2a): it is picked
  // below, and every live variant then needs a value for it.
  const choices = locked ? secondAxisChoices(publishedAxes, fields, maxAxes) : [];
  const secondCode =
    locked && publishedAxes?.length === 1
      ? axes.find((axis) => !publishedAxes.includes(axis))
      : undefined;
  const secondField =
    secondCode === undefined ? undefined : fields.find((field) => field.code === secondCode);
  const addingSecond = secondField !== undefined;

  function addSecond(code: string) {
    const keep = axisCandidates(fields)
      .map((field) => field.code)
      .filter((item) => item === code || axes.includes(item));
    setActive((current) => ({ ...current, [code]: [] }));
    onChange({ rows: [...rows], axes: keep });
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

  const first = axes[0] === undefined ? undefined : fields.find((field) => field.code === axes[0]);
  const second = axes[1] === undefined ? undefined : fields.find((field) => field.code === axes[1]);
  const optionsOf = (field: FormField) =>
    field.options.filter((option) => (active[field.code] ?? []).includes(option.code));

  return (
    <Card title={t('catalog.edit.variants')}>
      <p className="text-sm text-fg-muted" aria-live="polite">
        {t('catalog.product.variants-count', { count: rows.length, max })}
      </p>
      {nearLimit(rows.length, max) ? (
        <Banner tone="attention">{t('catalog.edit.grid.near-limit', { max })}</Banner>
      ) : null}
      {full ? <Banner tone="attention">{t('catalog.edit.grid.at-limit', { max })}</Banner> : null}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{t('catalog.edit.grid.step-axes')}</h3>
        <p className="text-sm text-fg-muted">
          {t(locked ? 'catalog.edit.grid.axes-locked' : 'catalog.edit.grid.axes-help')}
        </p>
        {candidates.length === 0 ? (
          <Banner tone="attention">{t('catalog.edit.grid.no-axes')}</Banner>
        ) : (
          candidates.map((field) => (
            <CheckboxRow
              key={field.code}
              name={`axis.${field.code}`}
              label={
                field.code === secondCode
                  ? t('catalog.edit.grid.axis-adding', { type: nameOf(field) })
                  : nameOf(field)
              }
              checked={axes.includes(field.code)}
              disabled={
                field.code === secondCode
                  ? false
                  : locked || (!axes.includes(field.code) && axes.length >= MAX_AXES)
              }
              onChange={(event) =>
                field.code === secondCode
                  ? dropSecond()
                  : toggleAxis(field.code, event.target.checked)
              }
            />
          ))
        )}
      </section>

      {locked && axes.length === 0 && rows.length > 0 ? (
        <Banner tone="attention">
          {t('catalog.edit.grid.locked-no-axes', { count: rows.length })}
        </Banner>
      ) : null}

      {axes.length === 0 || addingSecond ? null : (
        <section className="flex flex-col gap-3 border-t border-line pt-3">
          <h3 className="font-medium">{t('catalog.edit.grid.step-options')}</h3>
          {axes.map((axis) => {
            const field = fields.find((item) => item.code === axis);
            if (field === undefined) return null;
            return (
              <fieldset key={axis} className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-fg-secondary">
                  {nameOf(field)}
                </legend>
                {field.options.map((option) => (
                  <CheckboxRow
                    key={option.code}
                    name={`option.${axis}.${option.code}`}
                    label={pickLabel(option.labels, defaultLocale, option.code)}
                    checked={(active[axis] ?? []).includes(option.code)}
                    onChange={(event) => toggleOption(axis, option.code, event.target.checked)}
                  />
                ))}
              </fieldset>
            );
          })}
        </section>
      )}

      <SecondAxisStep
        choices={choices}
        second={secondField}
        rows={rows}
        fields={fields}
        defaultLocale={defaultLocale}
        review={review}
        onAdd={addSecond}
        onValue={(row, code) =>
          onChange({
            rows: rows.map((item) =>
              item === row
                ? { ...item, options: { ...item.options, [secondField?.code ?? '']: code } }
                : item,
            ),
            axes: [...axes],
          })
        }
        onRemove={dropSecond}
      />

      {first === undefined || addingSecond ? null : (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="font-medium">{t('catalog.edit.grid.step-grid')}</h3>
          {combos.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('catalog.edit.grid.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <caption className="sr-only">{t('catalog.edit.grid.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-2 text-start font-medium">
                      {second === undefined
                        ? nameOf(first)
                        : `${nameOf(first)} / ${nameOf(second)}`}
                    </th>
                    {second === undefined ? (
                      <th scope="col" className="p-2 text-start font-medium">
                        {t('catalog.edit.grid.sold')}
                      </th>
                    ) : (
                      optionsOf(second).map((option) => (
                        <th key={option.code} scope="col" className="p-2 text-start font-medium">
                          {pickLabel(option.labels, defaultLocale, option.code)}
                        </th>
                      ))
                    )}
                  </tr>
                </thead>
                <tbody>
                  {optionsOf(first).map((rowOption) => (
                    <tr key={rowOption.code} className="border-t border-line">
                      <th scope="row" className="p-2 text-start font-medium">
                        {pickLabel(rowOption.labels, defaultLocale, rowOption.code)}
                      </th>
                      {second === undefined ? (
                        <td className="p-2">
                          {tick({
                            key: `${first.code}=${rowOption.code}`,
                            options: { [first.code]: rowOption.code },
                          })}
                        </td>
                      ) : (
                        optionsOf(second).map((colOption) => (
                          <td key={colOption.code} className="p-2">
                            {tick({
                              key: `${first.code}=${rowOption.code};${second.code}=${colOption.code}`,
                              options: {
                                [first.code]: rowOption.code,
                                [second.code]: colOption.code,
                              },
                            })}
                          </td>
                        ))
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {first === undefined ? null : (
        <VariantDetails
          rows={rows}
          titleOf={(row) => variantTitle(row, fields, defaultLocale, row.key)}
          productId={productId}
          galleryIds={galleryIds}
          heading={addingSecond ? t('catalog.edit.grid.step-details-adding') : undefined}
          notices={notices}
          onRow={(row, next) =>
            onChange({ rows: rows.map((item) => (item === row ? next : item)), axes: [...axes] })
          }
        />
      )}

      <Dialog
        open={pending !== null}
        title={t(
          pending?.kind === 'axes'
            ? 'catalog.edit.grid.axes-dialog'
            : 'catalog.edit.grid.remove-dialog',
        )}
        onClose={() => setPending(null)}
        initialFocus={cancel}
        actions={
          <>
            <Button ref={cancel} variant="secondary" onClick={() => setPending(null)}>
              {t('catalog.edit.grid.keep')}
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                if (pending?.kind === 'drop') pending.then();
                else if (pending?.kind === 'axes') {
                  const next = [...pending.axes];
                  setActive((current) =>
                    Object.fromEntries(next.map((axis) => [axis, current[axis] ?? []])),
                  );
                  setPending(null);
                  onChange({ rows: [], axes: next });
                }
              }}
            >
              {t(
                pending?.kind === 'axes'
                  ? 'catalog.edit.grid.axes-confirm'
                  : 'catalog.edit.grid.remove-confirm',
              )}
            </Button>
          </>
        }
      >
        {pending?.kind === 'drop' ? (
          <p>{t('catalog.edit.grid.remove-body', { count: pending.rows.length })}</p>
        ) : (
          <p>{t('catalog.edit.grid.axes-body')}</p>
        )}
      </Dialog>
    </Card>
  );
}
