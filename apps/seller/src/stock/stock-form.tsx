'use client';

import {
  Banner,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingsDrawer,
  SettingsErrorSummary,
  type FieldChange,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { SettingsConflictView } from '../settings/conflict-view.tsx';
import { useDrawerLabels } from '../settings/drawer-labels.ts';
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

const NAME_ROW = 'setting-stock-name';
const ZONE_ROW = 'setting-stock-zone';
const addressRow = (key: string) => `setting-stock-address-${key}`;

/**
 * The editor of one stock location, in the settings drawer (Cancel, then the verb). It is an entry
 * of a list, not a page setting; its fields are template rows, and a refused save lists them in a
 * summary at the top of the drawer.
 */
export function StockForm({
  source,
  options,
  pending,
  problem,
  failedWrites,
  conflictId,
  onSubmit,
  onCancel,
}: {
  /** The location being edited, or null for a new one. */
  readonly source: SourceView | null;
  readonly options: StockFormOptions;
  readonly pending: boolean;
  readonly problem: StockProblem | null;
  /** Rises with each refused write: the summary takes focus again. */
  readonly failedWrites: number;
  /** Set when someone saved first: `source` is then the location as saved now, and the draft stays. */
  readonly conflictId: number | null;
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
  const labels = useDrawerLabels(source === null ? t('stock.form.add') : t('stock.form.save'));
  // What the form held when it opened: closing with anything else asks first.
  const [start] = useState(() => JSON.stringify([name, address, zone]));
  const dirty = JSON.stringify([name, address, zone]) !== start;

  function fieldError(path: string): string | undefined {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key);
  }

  function submit() {
    onSubmit({ name, address: addressOf(address), timeZone: zone === '' ? null : zone });
  }

  const labelOf = (field: { readonly key: string; readonly labelKey: string }) =>
    t.has(field.labelKey) ? t(field.labelKey) : field.key;
  const invalid = [
    fieldError('name') === undefined
      ? null
      : { id: NAME_ROW, label: t('stock.form.name'), reason: fieldError('name') },
    ...options.fields.map((field) =>
      fieldError(`address.${field.key}`) === undefined
        ? null
        : {
            id: addressRow(field.key),
            label: labelOf(field),
            reason: fieldError(`address.${field.key}`),
          },
    ),
    fieldError('timeZone') === undefined
      ? null
      : { id: ZONE_ROW, label: t('stock.form.zone'), reason: fieldError('timeZone') },
  ].filter((item) => item !== null);

  // What differs between the location as saved now and the draft in the boxes.
  const unset = t('settings.conflict.unset');
  const changes: FieldChange[] = [];
  if (conflictId !== null && source !== null) {
    const add = (key: string, label: string, saved: string, yours: string) => {
      if (saved !== yours) {
        changes.push({ key, label, saved: saved || unset, yours: yours || unset });
      }
    };
    add('name', t('stock.form.name'), source.name, name.trim());
    for (const field of options.fields) {
      add(
        `address.${field.key}`,
        labelOf(field),
        source.address?.[field.key] ?? '',
        (address[field.key] ?? '').trim(),
      );
    }
    const own = t('stock.form.zone-own');
    add('timeZone', t('stock.form.zone'), source.timeZone ?? own, zone === '' ? own : zone);
  }
  const hasNotice = problem !== null || invalid.length > 0 || conflictId !== null;

  const notice = hasNotice ? (
    <div className="flex flex-col gap-3">
      {invalid.length === 0 ? null : (
        <SettingsErrorSummary
          title={t('settings.errors.title', { count: invalid.length })}
          items={invalid}
          focusSignal={failedWrites}
        />
      )}
      {conflictId === null ? null : source === null ? (
        <Banner tone="attention">{t('stock.error.list-changed')}</Banner>
      ) : (
        <SettingsConflictView conflictId={conflictId} changes={changes} />
      )}
      {problem === null ? null : (
        <Banner tone="critical">{t(problem.form.key, problem.form.values)}</Banner>
      )}
    </div>
  ) : undefined;

  return (
    <SettingsDrawer
      open
      onClose={onCancel}
      title={source === null ? t('stock.form.add-title') : t('stock.form.edit-title')}
      notice={notice}
      onSubmit={submit}
      pending={pending}
      dirty={dirty}
      labels={labels}
    >
      {/* The rows carry their own side padding: the negative margin cancels the drawer's. */}
      <div className="-mx-5 flex flex-col">
        <SettingRow id={NAME_ROW} label={t('stock.form.name')} error={fieldError('name')}>
          <SettingInput
            name="name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingRow>
        <fieldset>
          <legend className="px-5 pt-4 text-sm font-medium text-fg">
            {t('stock.form.address')}
          </legend>
          <p className="px-5 pt-1 text-sm text-fg-muted">{t('stock.form.address-help')}</p>
          {options.fields.map((field) => {
            const common = {
              id: addressRow(field.key),
              label: labelOf(field),
              error: fieldError(`address.${field.key}`),
            };
            return field.key === options.regionField ? (
              <SettingRow key={field.key} {...common}>
                <SettingSelect
                  name={`address.${field.key}`}
                  value={address[field.key] ?? ''}
                  placeholder={t('stock.form.choose-region')}
                  options={options.regions.map((value) => ({ value, label: value }))}
                  onChange={(event) => setAddress({ ...address, [field.key]: event.target.value })}
                />
              </SettingRow>
            ) : (
              <SettingRow key={field.key} {...common} optionalLabel={t('stock.optional')}>
                <SettingInput
                  name={`address.${field.key}`}
                  value={address[field.key] ?? ''}
                  maxLength={field.maxLength}
                  onChange={(event) => setAddress({ ...address, [field.key]: event.target.value })}
                />
              </SettingRow>
            );
          })}
        </fieldset>
        <SettingRow
          id={ZONE_ROW}
          label={t('stock.form.zone')}
          help={t('stock.form.zone-help')}
          error={fieldError('timeZone')}
        >
          <SettingSelect
            name="timeZone"
            value={zone}
            placeholder={t('stock.form.zone-own')}
            options={options.zones.map((value) => ({ value, label: value }))}
            onChange={(event) => setZone(event.target.value)}
          />
        </SettingRow>
      </div>
    </SettingsDrawer>
  );
}
