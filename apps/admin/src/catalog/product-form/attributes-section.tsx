'use client';

import { Card, SearchSelect, Select, TextField, type SearchSelectLabels } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  attributeProblem,
  pickLabel,
  type AttributeInput,
  type AttributeInputs,
} from './draft-content.ts';
import type { DraftSaved, FormField } from './types.ts';

/** The saved map of a localisable text without its empty-locale key, so the default language is not written twice. */
function mapOf(current: AttributeInput | undefined): Record<string, string> {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return {};
  return Object.fromEntries(
    Object.entries(current as Record<string, string>).filter(([key]) => key !== ''),
  );
}

const INPUT_TYPE: Readonly<Record<string, string>> = {
  integer: 'text',
  decimal: 'text',
  date: 'date',
};

/**
 * The attribute fields of the product's family, one input each by data type. A text is written in
 * the default language only. Lists of values are searchable (john, 31 Oct).
 */
export function AttributesSection({
  fields,
  inputs,
  defaultLocale,
  refused,
  labels,
  onChange,
}: {
  readonly fields: readonly FormField[];
  readonly inputs: AttributeInputs;
  readonly defaultLocale: string;
  readonly refused: DraftSaved['refusedFields'];
  readonly labels: Partial<SearchSelectLabels>;
  readonly onChange: (code: string, value: AttributeInput | undefined) => void;
}) {
  const t = useTranslations('catalog.productForm');
  if (fields.length === 0) return null;

  function text(field: FormField) {
    const label = pickLabel(field.names, defaultLocale, field.code);
    const current = inputs[field.code];
    const value =
      typeof current === 'string'
        ? current
        : typeof current === 'object' && current !== null && !Array.isArray(current)
          ? ((current as Record<string, string>)[''] ??
            (current as Record<string, string>)[defaultLocale] ??
            '')
          : '';
    const problem = attributeProblem(field, value);
    const flagged = refused.some((item) => item.ref === field.code);
    return (
      <TextField
        key={field.code}
        name={`attribute.${field.code}`}
        label={label}
        type={INPUT_TYPE[field.dataType] ?? 'text'}
        {...(field.required ? {} : { optionalLabel: t('optional') })}
        value={value}
        error={
          flagged
            ? t('refused-field')
            : problem === null
              ? undefined
              : t(`attribute.problem.${problem}`, { length: field.bounds.maxLength ?? 0 })
        }
        onChange={(event) =>
          onChange(
            field.code,
            // A localisable text keeps its map shape: only the default language is written here.
            field.localizable
              ? { ...mapOf(current), [defaultLocale]: event.target.value }
              : event.target.value,
          )
        }
      />
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
      case 'boolean':
        return (
          <Select
            key={field.code}
            name={`attribute.${field.code}`}
            label={label}
            placeholder={t('attribute.unset')}
            options={[
              { value: 'yes', label: t('attribute.yes') },
              { value: 'no', label: t('attribute.no') },
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
      case 'select': {
        const chosen = typeof current === 'string' ? current : '';
        return (
          <SearchSelect
            key={field.code}
            name={`attribute.${field.code}`}
            label={label}
            placeholder={t('attribute.unset')}
            clearLabel={t('attribute.unset')}
            options={options}
            value={options.find((option) => option.value === chosen) ?? null}
            labels={labels}
            onChange={(option) => onChange(field.code, option === null ? undefined : option.value)}
          />
        );
      }
      case 'multi-select': {
        const chosen = Array.isArray(current) ? (current as readonly string[]) : [];
        return (
          <SearchSelect
            key={field.code}
            multiple
            name={`attribute.${field.code}`}
            label={label}
            placeholder={t('attribute.unset')}
            options={options}
            value={options.filter((option) => chosen.includes(option.value))}
            labels={labels}
            onChange={(picked) =>
              onChange(
                field.code,
                picked.map((option) => option.value),
              )
            }
          />
        );
      }
      default:
        return text(field);
    }
  }

  return <Card title={t('details')}>{fields.map(one)}</Card>;
}
