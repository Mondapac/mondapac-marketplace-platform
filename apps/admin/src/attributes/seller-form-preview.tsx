'use client';

import { Badge, Banner, Button, Dialog, Select, TextAreaField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { callApi } from '../api/client.ts';
import { nameIn } from '../categories/tree-model.ts';
import { API_CATEGORIES, type TreeBody } from '../categories/types.ts';
import { type EditorEntry, type EditorState } from './feature-set-editor-model.ts';
import { NEEDS_OPTIONS, useAttributeOptions, type OptionsState } from './preview-options.ts';
import { textIn, type MarketLocales, type RequirementLevel } from './types.ts';

/** Chips shown before "+ N more". */
const CHIP_LIMIT = 6;

/**
 * "Seller form preview" (attributes A4, screen 02): a read-only render of the form a seller sees
 * for the feature set as edited, unsaved changes included. Controls follow the data type; the
 * choices of a select or multi-select are read from the attribute when the preview opens.
 * Nothing typed here is kept or sent.
 */
export function SellerFormPreview({
  open,
  onClose,
  featureSetId,
  featureSetCode,
  state,
  locales,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly featureSetId: string;
  readonly featureSetCode: string;
  readonly state: EditorState;
  readonly locales: MarketLocales;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  const [categories, setCategories] = useState<
    readonly { readonly id: string; readonly name: string }[] | null
  >(null);
  const [categoriesFailed, setCategoriesFailed] = useState(false);
  const [categoryId, setCategoryId] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    void callApi<TreeBody>('GET', API_CATEGORIES).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setCategoriesFailed(true);
        return;
      }
      setCategoriesFailed(false);
      setCategories(
        (result.body.categories ?? [])
          .filter((row) => row.featureSetId === featureSetId)
          .map((row) => ({
            id: row.id,
            name: nameIn(row.names, result.body.defaultLocale) ?? row.slug,
          })),
      );
    });
    return () => {
      live = false;
    };
  }, [open, featureSetId]);

  const needing = useMemo(
    () => [
      ...new Set(
        state.groups
          .flatMap((group) => group.entries)
          .filter((entry) => entry.attributeId != null && NEEDS_OPTIONS.has(entry.dataType ?? ''))
          .map((entry) => entry.attributeId as string),
      ),
    ],
    [state],
  );
  const { states, retry } = useAttributeOptions(needing, open);
  const empty = state.groups.every((group) => group.entries.length === 0);

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={onClose}
      size="form"
      actions={<Button onClick={onClose}>{t('close')}</Button>}
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-muted">{t('lede', { code: featureSetCode })}</p>
        {categoriesFailed ? <Banner tone="info">{t('categories-error')}</Banner> : null}
        {categories === null ? null : categories.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">{t('no-categories')}</p>
        ) : (
          <Select
            label={t('as')}
            value={categoryId === '' ? (categories[0]?.id ?? '') : categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            options={categories.map((row) => ({ value: row.id, label: row.name }))}
          />
        )}
        <p className="m-0 text-sm text-fg-muted">{t('legend')}</p>
        {empty ? <p className="m-0 text-fg-muted">{t('empty')}</p> : null}
        {state.groups
          .filter((group) => group.entries.length > 0)
          .map((group) => (
            <section
              key={group.groupCode}
              aria-label={textIn(
                group.names,
                locales.default,
                locales.default,
                t('no-group-name', { group: group.groupCode }),
              )}
              className="flex flex-col gap-3"
            >
              <h3 className="m-0 text-base font-semibold text-fg">
                {textIn(
                  group.names,
                  locales.default,
                  locales.default,
                  t('no-group-name', { group: group.groupCode }),
                )}
              </h3>
              {group.entries.map((entry) => (
                <PreviewField
                  key={entry.code}
                  entry={entry}
                  locales={locales}
                  options={entry.attributeId == null ? undefined : states[entry.attributeId]}
                  onRetry={() => entry.attributeId != null && retry(entry.attributeId)}
                />
              ))}
            </section>
          ))}
      </div>
    </Dialog>
  );
}

function markerOf(level: RequirementLevel, t: (key: string) => string): string {
  return level === 'required' ? '*' : `(${t(level)})`;
}

function PreviewField({
  entry,
  locales,
  options,
  onRetry,
}: {
  readonly entry: EditorEntry;
  readonly locales: MarketLocales;
  readonly options: OptionsState | undefined;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  const name = textIn(entry.names, locales.default, locales.default, entry.code);
  const label = `${name} ${markerOf(entry.level, t)}`;
  const type = entry.dataType ?? 'text';

  if (type === 'long-text') return <TextAreaField name={entry.code} label={label} rows={3} />;
  if (type === 'integer' || type === 'decimal') {
    return (
      <TextField
        name={entry.code}
        label={label}
        type="number"
        inputMode={type === 'integer' ? 'numeric' : 'decimal'}
      />
    );
  }
  if (type === 'date') return <TextField name={entry.code} label={label} type="date" />;
  if (type === 'boolean') {
    return (
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0 text-sm font-medium text-fg">{label}</legend>
        <div className="flex gap-4">
          {(['yes', 'no'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name={`preview-${entry.code}`} value={value} />
              {t(value)}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (type === 'select' || type === 'multi-select') {
    return (
      <ChoiceField
        entry={entry}
        label={label}
        multi={type === 'multi-select'}
        options={options}
        locales={locales}
        onRetry={onRetry}
      />
    );
  }
  // A measure shows its number; its unit list is not read for the preview.
  if (type === 'measure') {
    return (
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField name={entry.code} label={label} type="number" inputMode="decimal" />
        </div>
      </div>
    );
  }
  return <TextField name={entry.code} label={label} />;
}

function ChoiceField({
  entry,
  label,
  multi,
  options,
  locales,
  onRetry,
}: {
  readonly entry: EditorEntry;
  readonly label: string;
  readonly multi: boolean;
  readonly options: OptionsState | undefined;
  readonly locales: MarketLocales;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  if (options === undefined || options.kind === 'loading') {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {t('options-loading')}
        </p>
      </div>
    );
  }
  if (options.kind === 'error') {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        <p role="alert" className="m-0 text-sm text-fg-muted">
          {t('options-error')}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          {t('options-retry')}
        </Button>
      </div>
    );
  }
  const choices = options.detail.options
    .filter((option) => option.active)
    .map((option) => ({
      value: option.code,
      label: textIn(option.labels, locales.default, locales.default, option.code),
    }));
  const help = textIn(options.detail.display.helpText, locales.default, locales.default, '');
  if (multi) {
    return <MultiChoice label={label} choices={choices} help={help} />;
  }
  return (
    <Select
      label={label}
      placeholder={t('choose')}
      options={choices}
      help={help === '' ? undefined : help}
      defaultValue=""
      name={entry.code}
    />
  );
}

function MultiChoice({
  label,
  choices,
  help,
}: {
  readonly label: string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly help: string;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [all, setAll] = useState(false);
  const shown = all ? choices : choices.slice(0, CHIP_LIMIT);
  const hidden = choices.length - shown.length;
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-sm font-medium text-fg">{label}</legend>
      {choices.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('no-options')}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {shown.map((choice) => (
            <label key={choice.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={picked.has(choice.value)}
                onChange={() => {
                  const next = new Set(picked);
                  if (!next.delete(choice.value)) next.add(choice.value);
                  setPicked(next);
                }}
              />
              <Badge tone="neutral">{choice.label}</Badge>
            </label>
          ))}
          {hidden > 0 ? (
            <Button variant="secondary" onClick={() => setAll(true)}>
              {t('more', { count: hidden })}
            </Button>
          ) : null}
        </div>
      )}
      <span className="text-sm text-fg-muted">{help === '' ? t('choose-many') : help}</span>
    </fieldset>
  );
}
