'use client';

import { Banner, Button, Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import type { StockProblem } from './errors.ts';
import type { SourceView, StockFormOptions } from './types.ts';

export interface SourceInput {
  readonly name: string;
  readonly address: Record<string, string> | null;
  readonly timeZone: string | null;
}

/** Empty address fields are left out; an address with no field at all is null. */
export function addressOf(values: Readonly<Record<string, string>>): Record<string, string> | null {
  const kept = Object.entries(values)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value !== '');
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

export function StockForm({
  source,
  options,
  pending,
  problem,
  onSubmit,
  onCancel,
}: {
  /** The location being edited, or null for a new one. */
  readonly source: SourceView | null;
  readonly options: StockFormOptions;
  readonly pending: boolean;
  readonly problem: StockProblem | null;
  readonly onSubmit: (input: SourceInput) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations();
  const [name, setName] = useState(source?.name ?? '');
  const [address, setAddress] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      options.fields.map((field) => [field.key, source?.address?.[field.key] ?? '']),
    ),
  );
  const [zone, setZone] = useState(source?.timeZone ?? '');

  function fieldError(path: string): string | undefined {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    onSubmit({ name, address: addressOf(address), timeZone: zone === '' ? null : zone });
  }

  return (
    <Card title={source === null ? t('stock.form.add-title') : t('stock.form.edit-title')}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {problem === null ? null : (
          <Banner tone="critical">{t(problem.form.key, problem.form.values)}</Banner>
        )}
        <TextField
          name="name"
          label={t('stock.form.name')}
          value={name}
          maxLength={80}
          error={fieldError('name')}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 text-sm font-medium text-fg">{t('stock.form.address')}</legend>
          <p className="text-sm text-fg-muted">{t('stock.form.address-help')}</p>
          {options.fields.map((field) => {
            const label = t.has(field.labelKey) ? t(field.labelKey) : field.key;
            const common = {
              name: `address.${field.key}`,
              label,
              value: address[field.key] ?? '',
              error: fieldError(`address.${field.key}`),
            };
            return field.key === options.regionField ? (
              <Select
                key={field.key}
                {...common}
                placeholder={t('stock.form.choose-region')}
                options={options.regions.map((value) => ({ value, label: value }))}
                onChange={(event) => setAddress({ ...address, [field.key]: event.target.value })}
              />
            ) : (
              <TextField
                key={field.key}
                {...common}
                maxLength={field.maxLength}
                optionalLabel={t('stock.optional')}
                onChange={(event) => setAddress({ ...address, [field.key]: event.target.value })}
              />
            );
          })}
        </fieldset>
        <Select
          name="timeZone"
          label={t('stock.form.zone')}
          help={t('stock.form.zone-help')}
          value={zone}
          error={fieldError('timeZone')}
          placeholder={t('stock.form.zone-own')}
          options={options.zones.map((value) => ({ value, label: value }))}
          onChange={(event) => setZone(event.target.value)}
        />
        <div className="flex gap-3">
          <Button type="submit" loading={pending}>
            {t('stock.form.save')}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {t('stock.form.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
