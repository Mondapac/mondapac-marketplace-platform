'use client';

import { Card, CheckboxRow, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  attributeProblem,
  isMeasureInput,
  measureProblem,
  pickLabel,
  type AttributeInput,
  type AttributeInputs,
} from './draft-content.ts';
import type { DraftSaved, FormField, FormUnit } from './types.ts';

const INPUT_TYPE: Readonly<Record<string, string>> = {
  integer: 'text',
  decimal: 'text',
  date: 'date',
};

/** The attribute fields of the product's family, one input each by data type. */
export function AttributesSection({
  fields,
  units,
  inputs,
  locales,
  defaultLocale,
  refused,
  onChange,
}: {
  readonly fields: readonly FormField[];
  /** The Market's units with their labels; a measure field names the ones it offers by code. */
  readonly units: readonly FormUnit[];
  readonly inputs: AttributeInputs;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly refused: DraftSaved['refusedFields'];
  readonly onChange: (code: string, value: AttributeInput | undefined) => void;
}) {
  const t = useTranslations();
  if (fields.length === 0) return null;
  const refusedAt = (code: string, locale: string): boolean =>
    refused.some((item) => item.ref === code && (item.locale === locale || item.locale === ''));

  function text(field: FormField, locale: string | null) {
    const label = pickLabel(field.names, defaultLocale, field.code);
    const current = inputs[field.code];
    const value =
      locale === null
        ? typeof current === 'string'
          ? current
          : ''
        : typeof current === 'object' && !Array.isArray(current)
          ? ((current as Record<string, string>)[locale] ?? '')
          : '';
    const problem = locale === null ? attributeProblem(field, value) : null;
    const flagged = refusedAt(field.code, locale ?? defaultLocale);
    return (
      <TextField
        key={`${field.code}.${locale ?? ''}`}
        name={`attribute.${field.code}${locale === null ? '' : `.${locale}`}`}
        label={locale === null ? label : `${label} (${locale})`}
        type={INPUT_TYPE[field.dataType] ?? 'text'}
        {...(field.required && (locale === null || locale === defaultLocale)
          ? {}
          : { optionalLabel: t('catalog.create.optional') })}
        value={value}
        error={
          flagged
            ? t('catalog.edit.refused-field')
            : problem === null
              ? undefined
              : t(`catalog.edit.attribute.problem.${problem}`, {
                  length: field.bounds.maxLength ?? 0,
                })
        }
        onChange={(event) => {
          if (locale === null) onChange(field.code, event.target.value);
          else {
            const map = typeof current === 'object' && !Array.isArray(current) ? current : {};
            onChange(field.code, {
              ...(map as Record<string, string>),
              [locale]: event.target.value,
            });
          }
        }}
      />
    );
  }

  /** A number typed in the unit picked beside it; saved in base units (draft-content). */
  function measure(field: FormField) {
    const label = pickLabel(field.names, defaultLocale, field.code);
    const settings = field.measure;
    if (settings === undefined) return null;
    const current = inputs[field.code];
    const input = isMeasureInput(current) ? current : { amount: '', unit: settings.defaultUnit };
    const problem = measureProblem(field, input);
    const unitOptions = settings.units.map((code) => ({
      value: code,
      label: pickLabel(units.find((unit) => unit.code === code)?.labels ?? {}, defaultLocale, code),
    }));
    return (
      <div key={field.code} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <TextField
          name={`attribute.${field.code}`}
          label={label}
          type="text"
          inputMode="decimal"
          dir="ltr"
          {...(field.required ? {} : { optionalLabel: t('catalog.create.optional') })}
          value={input.amount}
          error={
            refusedAt(field.code, defaultLocale)
              ? t('catalog.edit.refused-field')
              : problem === null
                ? undefined
                : t(`catalog.edit.attribute.problem.${problem}`, { places: settings.decimals })
          }
          onChange={(event) =>
            onChange(field.code, { amount: event.target.value, unit: input.unit })
          }
        />
        <Select
          name={`attribute.${field.code}.unit`}
          label={t('catalog.edit.attribute.unit')}
          options={unitOptions}
          value={input.unit}
          onChange={(event) =>
            onChange(field.code, { amount: input.amount, unit: event.target.value })
          }
        />
      </div>
    );
  }

  function one(field: FormField) {
    const label = pickLabel(field.names, defaultLocale, field.code);
    const current = inputs[field.code];
    const options = field.options.map((option) => ({
      value: option.code,
      label: pickLabel(option.labels, defaultLocale, option.code),
    }));
    switch (field.dataType) {
      case 'measure':
        return measure(field);
      case 'boolean':
        return (
          <Select
            key={field.code}
            name={`attribute.${field.code}`}
            label={label}
            placeholder={t('catalog.edit.attribute.unset')}
            options={[
              { value: 'yes', label: t('catalog.edit.attribute.yes') },
              { value: 'no', label: t('catalog.edit.attribute.no') },
            ]}
            value={current === true ? 'yes' : current === false ? 'no' : ''}
            onChange={(event) =>
              onChange(
                field.code,
                event.target.value === '' ? undefined : event.target.value === 'yes',
              )
            }
          />
        );
      case 'select':
        return (
          <Select
            key={field.code}
            name={`attribute.${field.code}`}
            label={label}
            placeholder={t('catalog.edit.attribute.unset')}
            options={options}
            value={typeof current === 'string' ? current : ''}
            onChange={(event) =>
              onChange(field.code, event.target.value === '' ? undefined : event.target.value)
            }
          />
        );
      case 'multi-select': {
        const chosen = Array.isArray(current) ? (current as readonly string[]) : [];
        return (
          <fieldset key={field.code} className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg">{label}</legend>
            {options.map((option) => (
              <CheckboxRow
                key={option.value}
                name={`attribute.${field.code}.${option.value}`}
                label={option.label}
                checked={chosen.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    field.code,
                    event.target.checked
                      ? [...chosen, option.value]
                      : chosen.filter((code) => code !== option.value),
                  )
                }
              />
            ))}
          </fieldset>
        );
      }
      default:
        if (field.localizable && (field.dataType === 'text' || field.dataType === 'long-text')) {
          return (
            <div key={field.code} className="flex flex-col gap-3">
              {locales.map((locale) => text(field, locale))}
            </div>
          );
        }
        return text(field, null);
    }
  }

  return <Card title={t('catalog.edit.attributes')}>{fields.map(one)}</Card>;
}
