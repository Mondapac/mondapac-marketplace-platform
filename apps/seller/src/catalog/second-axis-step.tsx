'use client';

import { Banner, Button, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { pickLabel, variantTitle, type VariantRow } from './draft-content.ts';
import type { FormField } from './types.ts';

/**
 * "Add a second type" (variants V9d, catalog design 4.2a): a published product that varies on one
 * type may add one more, once. Step 1 picks the new type; step 2 gives every live variant its value
 * for it (all required). The change goes to review: it rewrites the labels of the live variants.
 */
export function SecondAxisStep({
  choices,
  second,
  rows,
  fields,
  defaultLocale,
  onAdd,
  onValue,
  onRemove,
}: {
  /** The types that could be added; empty once a second type is chosen. */
  readonly choices: readonly FormField[];
  /** The second type chosen in this draft, if any. */
  readonly second: FormField | undefined;
  readonly rows: readonly VariantRow[];
  readonly fields: readonly FormField[];
  readonly defaultLocale: string;
  readonly onAdd: (code: string) => void;
  readonly onValue: (row: VariantRow, code: string) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('catalog.edit.second');
  const [picked, setPicked] = useState('');
  const [open, setOpen] = useState(false);
  const nameOf = (field: FormField) => pickLabel(field.names, defaultLocale, field.code);
  // A variant is named by what it already is, not by the value being asked for.
  const withoutSecond = (options: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(options).filter(([code]) => code !== second?.code));

  if (second === undefined) {
    if (choices.length === 0) return null;
    return (
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="font-medium">{t('title')}</h3>
        <p className="text-sm text-fg-muted">{t('help')}</p>
        {open ? (
          <div className="flex flex-col gap-3">
            <Select
              name="secondAxis"
              label={t('pick')}
              placeholder={t('choose')}
              options={choices.map((field) => ({ value: field.code, label: nameOf(field) }))}
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
            />
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  setPicked('');
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={picked === ''}
                onClick={() => {
                  onAdd(picked);
                  setOpen(false);
                  setPicked('');
                }}
              >
                {t('add')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              {t('start')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="font-medium">{t('values-title', { type: nameOf(second) })}</h3>
      <Banner tone="info">{t('review')}</Banner>
      <p className="text-sm text-fg-muted">{t('values-help', { type: nameOf(second) })}</p>
      {rows.map((row, index) => (
        <Select
          key={row.key}
          name={`second.${row.key}`}
          label={t('value-for', {
            variant: variantTitle(
              { ...row, options: withoutSecond(row.options) },
              fields,
              defaultLocale,
              String(index + 1),
            ),
            type: nameOf(second),
          })}
          placeholder={t('choose')}
          required
          options={second.options.map((option) => ({
            value: option.code,
            label: pickLabel(option.labels, defaultLocale, option.code),
          }))}
          value={row.options[second.code] ?? ''}
          onChange={(event) => onValue(row, event.target.value)}
        />
      ))}
      <div>
        <Button variant="secondary" onClick={onRemove}>
          {t('remove')}
        </Button>
      </div>
    </section>
  );
}
