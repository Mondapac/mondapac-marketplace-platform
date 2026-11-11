'use client';

import { Banner, Button, Dialog, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import { ACCREDITATION_MAX, API_ISSUERS, NAME_MAX, type TypeChoice } from './types.ts';
import { useIssuerCall } from './use-issuer-call.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The "New issuer" button and its dialog. The issuer starts as Proposed; its page opens next. */
export function NewIssuer({
  types,
  typeNames,
  csrfToken,
}: {
  readonly types: readonly TypeChoice[];
  readonly typeNames: ReadonlyMap<string, string>;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.issuers');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('new.button')}</Button>
      {open ? (
        <NewIssuerDialog
          types={types}
          typeNames={typeNames}
          csrfToken={csrfToken}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function NewIssuerDialog({
  types,
  typeNames,
  csrfToken,
  onClose,
}: {
  readonly types: readonly TypeChoice[];
  readonly typeNames: ReadonlyMap<string, string>;
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('certificates.issuers.new');
  const tr = useTranslations();
  const formId = useId();
  const only = types.length === 1 ? types[0]!.typeId : '';
  const [typeId, setTypeId] = useState(only);
  const [name, setName] = useState('');
  const [accreditation, setAccreditation] = useState('');
  const [checked, setChecked] = useState(false);
  const call = useIssuerCall(csrfToken);

  const trimmed = name.trim();
  const nameError =
    checked && trimmed === ''
      ? t('name-required')
      : trimmed.length > NAME_MAX
        ? t('name-long')
        : undefined;
  const typeError = checked && typeId === '' ? t('type-required') : undefined;
  const accError =
    accreditation.trim().length > ACCREDITATION_MAX ? t('accreditation-long') : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (typeId === '' || trimmed === '' || nameError !== undefined || accError !== undefined)
      return;
    const acc = accreditation.trim();
    const answer = await call.run<{ readonly issuerId: string }>('POST', API_ISSUERS, {
      typeId,
      displayName: trimmed,
      ...(acc === '' ? {} : { accreditationNumber: acc }),
    });
    if (answer.ok) {
      const id = answer.body.issuerId;
      window.location.assign(
        UUID.test(id) ? `/certificates/issuers/${id}` : '/certificates/issuers',
      );
    }
  }

  return (
    <Dialog
      open
      title={t('title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
            {t('create')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        noValidate
      >
        <div aria-live="polite">
          {call.problem === null ? null : <Banner tone="critical">{tr(call.problem.key)}</Banner>}
        </div>
        <Select
          label={t('type')}
          required
          value={typeId}
          onChange={(event) => setTypeId(event.target.value)}
          placeholder={t('type-placeholder')}
          options={types.map((type) => ({
            value: type.typeId,
            label: typeNames.get(type.code) ?? type.code,
          }))}
          error={typeError}
        />
        <TextField
          label={t('name')}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          help={t('name-help')}
          error={nameError}
          autoComplete="off"
        />
        <TextField
          label={t('accreditation')}
          value={accreditation}
          onChange={(event) => setAccreditation(event.target.value)}
          help={t('accreditation-help')}
          error={accError}
          autoComplete="off"
        />
        <Banner tone="info">{t('proposed-note')}</Banner>
      </form>
    </Dialog>
  );
}
