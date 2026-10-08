'use client';

import { Banner, Button, Card, CheckboxRow, FormActionBar, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useFocusFirstInvalid } from '../auth/use-focus-first-invalid.ts';
import { nextHref } from './steps.ts';
import type { AddressSaved, FormDescriptors, MyFile, ZoneState } from './types.ts';
import { ProblemBanner } from './problem-banner.tsx';
import { useStepSave } from './use-step-save.ts';

type AddressValues = Record<string, string>;
type Fields = FormDescriptors['address']['fields'];

const AUTOCOMPLETE: Readonly<Record<string, string>> = {
  line1: 'address-line1',
  line2: 'address-line2',
  suburb: 'address-level2',
  state: 'address-level1',
  postcode: 'postal-code',
};

function blankAddress(
  fields: Fields,
  from: Readonly<Record<string, string>> | null,
): AddressValues {
  return Object.fromEntries(fields.map((field) => [field.key, from?.[field.key] ?? '']));
}

/** The browser's own zone: an untrusted hint the API applies only where no zone is set yet. */
function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function zoneName(zoneId: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: zoneId,
      timeZoneName: 'long',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? zoneId;
  } catch {
    return zoneId;
  }
}

function localTime(zoneId: string): string {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: zoneId,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date());
  } catch {
    return '';
  }
}

export function AddressForm({
  file,
  descriptors,
  csrfToken,
}: {
  readonly file: MyFile;
  readonly descriptors: FormDescriptors;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  const { fields, regionField, regions } = descriptors.address;
  const [address, setAddress] = useState(() => blankAddress(fields, file.address));
  const [differs, setDiffers] = useState(file.registeredAddress !== null);
  const [registered, setRegistered] = useState(() => blankAddress(fields, file.registeredAddress));
  const [zone, setZone] = useState<string | null>(file.timezone?.operatingTimezone ?? null);
  const [zoneTouched, setZoneTouched] = useState(false);
  const [result, setResult] = useState<{
    outside: boolean;
    timezone: ZoneState | null;
    zoneOptions: readonly string[];
  } | null>(
    file.address === null
      ? null
      : {
          outside: file.outsideServiceArea === true,
          timezone: file.timezone,
          zoneOptions: file.zoneOptions,
        },
  );
  const { pending, problem, save, focusKeys } = useStepSave(csrfToken);
  useFocusFirstInvalid(formRef, focusKeys);

  const region = regionField === null ? null : (address[regionField] ?? '');
  const regionZones = region === null ? [] : (descriptors.timezones[region] ?? []);
  // The zones of the region as it stands now; the last save's options only before a region is chosen.
  const zoneChoices = regionZones.length > 0 ? regionZones : (result?.zoneOptions ?? []);

  function label(key: string, fallback: string): string {
    return t.has(key) ? t(key) : fallback;
  }

  function fieldError(prefix: string, key: string): string | undefined {
    const message = problem?.fields[`${prefix}.${key}`];
    return message === undefined ? undefined : t(message);
  }

  function renderFields(
    values: AddressValues,
    update: (next: AddressValues) => void,
    prefix: string,
  ) {
    return fields.map((field) => {
      const common = {
        name: `${prefix}.${field.key}`,
        label: label(field.labelKey, field.key),
        error: fieldError(prefix, field.key),
        value: values[field.key] ?? '',
        maxLength: field.maxLength,
        autoComplete: AUTOCOMPLETE[field.key] ?? 'off',
      };
      if (field.key === regionField) {
        return (
          <Select
            key={field.key}
            name={common.name}
            label={common.label}
            error={common.error}
            value={common.value}
            placeholder={t('sellers.address.choose-region')}
            options={regions.map((value) => ({ value, label: value }))}
            autoComplete={common.autoComplete}
            onChange={(event) => update({ ...values, [field.key]: event.target.value })}
          />
        );
      }
      return (
        <TextField
          key={field.key}
          {...common}
          optionalLabel={field.required ? undefined : t('sellers.optional')}
          onChange={(event) => update({ ...values, [field.key]: event.target.value })}
        />
      );
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const hint = browserZone();
    const outcome = await save<AddressSaved>('sellers/my-file/address', {
      address,
      registeredAddress: differs ? registered : null,
      ...(zoneTouched && zone !== null ? { timezone: zone } : {}),
      ...(hint === null ? {} : { browserTimezone: hint }),
    });
    if (outcome?.ok) {
      const body = outcome.body;
      setResult({
        outside: body.outsideServiceArea,
        timezone: body.timezone,
        zoneOptions: body.zoneOptions,
      });
      setZone(body.timezone?.operatingTimezone ?? null);
      setZoneTouched(false);
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      {problem?.form ? <ProblemBanner message={t(problem.form.key)} /> : null}
      <Card title={t('sellers.address.title')}>
        <p className="text-sm text-fg-muted">{t('sellers.address.help.scope')}</p>
        {renderFields(address, setAddress, 'address')}
        {zoneChoices.length > 1 ? (
          <Select
            name="timezone"
            label={t('sellers.address.label.zone')}
            help={t('sellers.address.help.zone')}
            error={problem?.fields['timezone'] ? t(problem.fields['timezone']) : undefined}
            placeholder={t('sellers.address.choose-zone')}
            value={zone !== null && zoneChoices.includes(zone) ? zone : ''}
            options={zoneChoices.map((value) => ({
              value,
              label: `${zoneName(value)} (${value})`,
            }))}
            onChange={(event) => {
              setZone(event.target.value);
              setZoneTouched(true);
            }}
          />
        ) : null}
      </Card>
      <CheckboxRow
        label={t('sellers.address.different')}
        checked={differs}
        onChange={(event) => setDiffers(event.target.checked)}
      />
      {differs ? (
        <Card title={t('sellers.address.registered-title')}>
          {renderFields(registered, setRegistered, 'registeredAddress')}
        </Card>
      ) : null}
      {result?.outside ? (
        <Banner tone="attention">{t('sellers.error.address.outside-service-area')}</Banner>
      ) : null}
      {result && !result.outside && result.timezone === null ? (
        <Banner tone="attention">{t('sellers.error.timezone.unresolved')}</Banner>
      ) : null}
      {result && !result.outside && result.timezone ? (
        <Banner tone="success">
          {t('sellers.address.result.zone', {
            zoneName: zoneName(result.timezone.operatingTimezone),
            zoneId: result.timezone.operatingTimezone,
          })}{' '}
          {t('sellers.address.result.local-time', {
            time: localTime(result.timezone.operatingTimezone),
          })}
          <br />
          {t('sellers.address.help.zone')}
        </Banner>
      ) : null}
      <FormActionBar status={result && !problem && !pending ? t('sellers.status.saved') : null}>
        <Button type="submit" variant={result ? 'secondary' : 'primary'} loading={pending}>
          {t(
            pending
              ? 'sellers.action.saving'
              : result
                ? 'sellers.action.save'
                : 'sellers.action.save-continue',
          )}
        </Button>
        {result ? (
          <Link
            href={nextHref('address')}
            className="inline-flex h-(--mp-size-control) items-center rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover"
          >
            {t('sellers.action.continue')}
          </Link>
        ) : null}
      </FormActionBar>
    </form>
  );
}
