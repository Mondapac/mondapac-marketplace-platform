'use client';

import { CheckboxRow, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  BASE_UNIT,
  MEASURE_DIMENSIONS,
  measureDefaults,
  unitsOf,
  type EditorForm,
  type FieldErrors,
} from './editor.ts';
import { fieldKey } from './editor.ts';
import { textIn, type MarketUnit } from './types.ts';

/**
 * The unit settings of a number-with-unit attribute (attributes A3): the kind of quantity, which of
 * the Market's units a seller may pick, the unit offered first, the decimal places, and the lowest
 * and highest value. The Market decides which units exist; the administrator picks among them and
 * cannot add one. The lowest and highest value are in the base unit (g, ml, mm, count), the unit
 * values are stored in. Once published the kind of quantity is fixed and a unit in use stays on.
 */
export function MeasureSettings({
  form,
  units,
  defaultLocale,
  savedUnits,
  locked,
  errors,
  onChange,
}: {
  readonly form: EditorForm;
  readonly units: readonly MarketUnit[];
  readonly defaultLocale: string;
  /** Units the published attribute already offers: they stay on. Empty for a draft. */
  readonly savedUnits: readonly string[];
  /** True once published: the kind of quantity cannot change. */
  readonly locked: boolean;
  readonly errors: FieldErrors;
  readonly onChange: (next: Partial<EditorForm>) => void;
}) {
  const t = useTranslations('attributes.editor');
  const tm = useTranslations('attributes.editor.measure');
  const label = (code: string) =>
    textIn(units.find((unit) => unit.code === code)?.labels, defaultLocale, defaultLocale, code);
  const msg = (path: string) => {
    const reason = errors[path];
    return reason === undefined ? undefined : t(`field.${fieldKey(reason)}`);
  };
  const offered = unitsOf(units, form.measureDimension);
  const base = BASE_UNIT[form.measureDimension] ?? '';
  const baseText = base === '' ? '' : label(base);
  const chosen = form.measureUnits;

  return (
    <div className="flex flex-col gap-3">
      <Select
        name="measure-dimension"
        label={tm('dimension.label')}
        help={locked ? tm('dimension.locked') : tm('dimension.help')}
        disabled={locked}
        options={MEASURE_DIMENSIONS.filter((dimension) => unitsOf(units, dimension).length > 0).map(
          (dimension) => ({ value: dimension, label: tm(`dimension.${dimension}`) }),
        )}
        value={form.measureDimension}
        onChange={(event) => onChange(measureDefaults(units, event.target.value))}
      />
      <fieldset className="flex flex-col gap-2" aria-describedby="measure-units-help">
        <legend className="text-sm font-medium text-fg">{tm('units.label')}</legend>
        <p id="measure-units-help" className="text-sm text-fg-muted">
          {tm('units.help')}
        </p>
        {offered.map((unit) => {
          const on = chosen.includes(unit.code);
          const kept = savedUnits.includes(unit.code);
          return (
            <CheckboxRow
              key={unit.code}
              name={`measure-unit-${unit.code}`}
              label={label(unit.code)}
              {...(kept ? { help: tm('units.in-use') } : {})}
              checked={on}
              disabled={kept}
              onChange={(event) => {
                const next = event.target.checked
                  ? offered
                      .map((u) => u.code)
                      .filter((code) => chosen.includes(code) || code === unit.code)
                  : chosen.filter((code) => code !== unit.code);
                onChange({
                  measureUnits: next,
                  measureDefaultUnit: next.includes(form.measureDefaultUnit)
                    ? form.measureDefaultUnit
                    : (next[0] ?? ''),
                });
              }}
            />
          );
        })}
        {msg('bounds.measure.units') === undefined ? null : (
          <p role="alert" className="text-sm text-critical-fg">
            {msg('bounds.measure.units')}
          </p>
        )}
      </fieldset>
      <Select
        name="measure-default-unit"
        label={tm('default-unit.label')}
        help={tm('default-unit.help')}
        error={msg('bounds.measure.defaultUnit')}
        options={chosen.map((code) => ({ value: code, label: label(code) }))}
        value={form.measureDefaultUnit}
        onChange={(event) => onChange({ measureDefaultUnit: event.target.value })}
      />
      <TextField
        name="measure-decimals"
        label={tm('decimals.label')}
        help={tm('decimals.help')}
        inputMode="numeric"
        value={form.measureDecimals}
        error={msg('bounds.measure.decimals')}
        onChange={(event) => onChange({ measureDecimals: event.target.value })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          name="min"
          label={tm('min', { unit: baseText })}
          optionalLabel={t('optional')}
          inputMode="decimal"
          value={form.min}
          error={msg('bounds.min')}
          onChange={(event) => onChange({ min: event.target.value })}
        />
        <TextField
          name="max"
          label={tm('max', { unit: baseText })}
          optionalLabel={t('optional')}
          inputMode="decimal"
          value={form.max}
          error={msg('bounds.max')}
          onChange={(event) => onChange({ max: event.target.value })}
        />
      </div>
    </div>
  );
}
