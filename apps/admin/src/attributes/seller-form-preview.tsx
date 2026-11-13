'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  IconButton,
  RadioGroup,
  Select,
  TextAreaField,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { nameIn } from '../categories/tree-model.ts';
import { API_CATEGORIES, type TreeBody } from '../categories/types.ts';
import { CORE_GROUP, type EditorEntry, type EditorState } from './feature-set-editor-model.ts';
import { NEEDS_OPTIONS, useAttributeOptions, type OptionsState } from './preview-options.ts';
import {
  textIn,
  type AttributeDetail,
  type MarketLocales,
  type RequirementLevel,
} from './types.ts';

/** Chips shown before "+ N more". */
const CHIP_LIMIT = 6;
/** Category names listed before "+ N more". */
const CATEGORY_LIMIT = 8;

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

  useEffect(() => {
    if (!open) return;
    let live = true;
    void callApi<TreeBody>('GET', API_CATEGORIES).then((result) => {
      if (!live) return;
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
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
  // The core group always shows; the note is about the rest of the set.
  const empty = state.groups.every(
    (group) => group.groupCode === CORE_GROUP || group.entries.length === 0,
  );

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={onClose}
      size="form"
      actions={<Button onClick={onClose}>{t('close')}</Button>}
    >
      <div className="relative flex flex-col gap-4">
        <IconButton
          icon="x"
          label={t('close')}
          onClick={onClose}
          className="absolute -top-11 end-0"
        />
        <p className="m-0 text-sm text-fg-muted">{t('lede', { code: featureSetCode })}</p>
        {categoriesFailed ? <Banner tone="info">{t('categories-error')}</Banner> : null}
        {categories === null ? null : <PreviewingAs names={categories.map((row) => row.name)} />}
        <p className="m-0 text-sm text-fg-muted">{t('legend')}</p>
        {empty ? <p className="m-0 text-fg-muted">{t('empty')}</p> : null}
        {state.groups
          .filter((group) => group.entries.length > 0)
          .map((group) => ({ ...group, entries: orderedEntries(group.groupCode, group.entries) }))
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
                  core={group.groupCode === CORE_GROUP}
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

/** The category names shown as plain text: the form is the same for each, so there is nothing to pick. */
function PreviewingAs({ names }: { readonly names: readonly string[] }) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  if (names.length === 0) return <p className="m-0 text-sm text-fg-muted">{t('not-used')}</p>;
  if (names.length === 1) {
    return (
      <p className="m-0 text-sm text-fg-muted">
        {t('previewing-as', { category: names[0] ?? '' })}
      </p>
    );
  }
  const shown = names.slice(0, CATEGORY_LIMIT);
  const rest = names.length - shown.length;
  return (
    <p className="m-0 text-sm text-fg-muted">
      {t('used-by', { categories: shown.join(', ') })}
      {rest > 0 ? ` ${t('more', { count: rest })}` : ''}
    </p>
  );
}

/** The core group lists these first, in this order; any other core attribute follows. */
const CORE_ORDER = ['brand', 'country-of-origin'];

function orderedEntries(
  groupCode: string,
  entries: readonly EditorEntry[],
): readonly EditorEntry[] {
  if (groupCode !== CORE_GROUP) return entries;
  const rank = (code: string): number => {
    const at = CORE_ORDER.indexOf(code);
    return at < 0 ? CORE_ORDER.length : at;
  };
  // Stable: the entries the order does not name (net weight or volume) keep their own order.
  return [...entries].sort((a, b) => rank(a.code) - rank(b.code));
}

/** How a core attribute shows in the form, by its code: a select with these words. */
const CORE_FIELDS: Readonly<
  Record<string, { readonly placeholder: string; readonly hint?: string }>
> = {
  brand: { placeholder: 'brand-placeholder', hint: 'brand-hint' },
  'country-of-origin': { placeholder: 'country-placeholder' },
};

type T = ReturnType<typeof useTranslations>;

function labelOf(name: string, level: RequirementLevel, t: T): string {
  return level === 'required' ? `${name} *` : `${name} (${t(level)})`;
}

/** Read to a screen reader with the field; shows nothing. */
function RequiredNote({ level }: { readonly level: RequirementLevel }) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  return level === 'required' ? <span className="sr-only">{t('required')}</span> : null;
}

function PreviewField({
  entry,
  core,
  locales,
  options,
  onRetry,
}: {
  readonly entry: EditorEntry;
  readonly core: boolean;
  readonly locales: MarketLocales;
  readonly options: OptionsState | undefined;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  const name = textIn(entry.names, locales.default, locales.default, entry.code);
  const label = labelOf(name, entry.level, t);
  const required = entry.level === 'required';
  const type = entry.dataType ?? 'text';
  // Every control is a picture of the field: disabled, so it is no tab stop and keeps nothing.
  const common = { name: entry.code, label, disabled: true, required } as const;

  const coreField = core ? CORE_FIELDS[entry.code] : undefined;
  if (coreField !== undefined) {
    return (
      <Select
        {...common}
        placeholder={t(coreField.placeholder)}
        options={[]}
        help={coreField.hint === undefined ? undefined : t(coreField.hint)}
      />
    );
  }
  if (type === 'long-text') return <TextAreaField {...common} rows={3} />;
  if (type === 'integer' || type === 'decimal') {
    return (
      <TextField {...common} type="number" inputMode={type === 'integer' ? 'numeric' : 'decimal'} />
    );
  }
  if (type === 'date') return <TextField {...common} type="date" />;
  if (type === 'boolean') {
    return (
      <RadioGroup
        legend={label}
        name={`preview-${entry.code}`}
        value=""
        disabled
        onChange={() => {}}
        options={[
          { value: 'yes', label: t('yes') },
          { value: 'no', label: t('no') },
        ]}
        note={<RequiredNote level={entry.level} />}
      />
    );
  }
  if (type === 'select' || type === 'multi-select' || type === 'measure') {
    return (
      <OptionsGate label={label} options={options} onRetry={onRetry}>
        {(detail) => {
          if (type === 'measure')
            return <MeasureField {...common} detail={detail} locales={locales} />;
          const choices = detail.options
            .filter((option) => option.active)
            .map((option) => ({
              value: option.code,
              label: textIn(option.labels, locales.default, locales.default, option.code),
            }));
          const help = textIn(detail.display.helpText, locales.default, locales.default, '');
          return type === 'multi-select' ? (
            <MultiChoice label={label} level={entry.level} choices={choices} help={help} />
          ) : (
            <Select
              {...common}
              placeholder={t('choose')}
              options={choices}
              help={help === '' ? undefined : help}
            />
          );
        }}
      </OptionsGate>
    );
  }
  return <TextField {...common} />;
}

/** Loading and error of one attribute's read, then the field itself. */
function OptionsGate({
  label,
  options,
  onRetry,
  children,
}: {
  readonly label: string;
  readonly options: OptionsState | undefined;
  readonly onRetry: () => void;
  readonly children: (detail: AttributeDetail) => ReactNode;
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
  return <>{children(options.detail)}</>;
}

/** A number and the unit it is in, from the units the attribute allows. */
function MeasureField({
  detail,
  locales,
  ...common
}: {
  readonly detail: AttributeDetail;
  readonly locales: MarketLocales;
  readonly name: string;
  readonly label: string;
  readonly disabled: true;
  readonly required: boolean;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  const config = detail.bounds.measure;
  const units = (config?.units ?? []).map((code) => ({
    value: code,
    label: textIn(
      detail.units.find((unit) => unit.code === code)?.labels,
      locales.default,
      locales.default,
      code,
    ),
  }));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[1fr_8rem] items-end gap-2">
        <TextField {...common} type="number" inputMode="decimal" />
        <Select
          name={`${common.name}-unit`}
          label={t('unit')}
          disabled
          placeholder={units.length === 0 ? t('unit-placeholder') : undefined}
          options={units}
          defaultValue={config?.defaultUnit}
        />
      </div>
      {units.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('no-units')}</p> : null}
    </div>
  );
}

function MultiChoice({
  label,
  level,
  choices,
  help,
}: {
  readonly label: string;
  readonly level: RequirementLevel;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
  readonly help: string;
}) {
  const t = useTranslations('attributes.feature-sets.editor.preview');
  const [all, setAll] = useState(false);
  const shown = all ? choices : choices.slice(0, CHIP_LIMIT);
  const hidden = choices.length - shown.length;
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-sm font-medium text-fg">
        {label.replace(/ \*$/, '')}
        {level === 'required' ? (
          <>
            {' '}
            <span aria-hidden="true">*</span>
            <span className="sr-only"> {t('required')}</span>
          </>
        ) : null}
      </legend>
      {choices.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('no-options')}</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {shown.map((choice) => (
            <CheckboxRow
              key={choice.value}
              label={choice.label}
              checked={false}
              disabled
              readOnly
            />
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
