'use client';

import { Banner, Button, Dialog, TextAreaField, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import {
  EMPTY_FORM,
  bodyOf,
  checkForm,
  fieldsOf,
  formOf,
  type BrandFormState,
  type FieldErrors,
  type FieldName,
} from './brand-form.ts';
import {
  API_BRANDS,
  ALT_MAX,
  NAME_MAX,
  SUMMARY_MAX,
  type BrandRow,
  type BrandWrap,
} from './types.ts';
import { useBrandCall } from './use-brand-call.ts';

/**
 * The brand form in a dialog: a new brand (active at once, the admin is its approver) or the
 * whole content of an existing one. The slug can change only while the brand is a draft.
 *
 * TODO: the logo and the header image are asked for as image ids. There is no upload or media
 * picker in the admin panel yet; when one exists, replace the two id fields with it.
 */
export function BrandFormDialog({
  brand,
  csrfToken,
  onClose,
  onSaved,
  onStale,
}: {
  /** The brand to edit; absent for a new one. */
  readonly brand?: BrandRow;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (brand: BrandRow) => void;
  /** The brand changed meanwhile: the dialog is closed and the list read again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('brands.form');
  const tr = useTranslations();
  const editing = brand !== undefined;
  const slugEditable = !editing || brand.status === 'draft';
  const [form, setForm] = useState<BrandFormState>(
    brand === undefined ? EMPTY_FORM : formOf(brand),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const call = useBrandCall(csrfToken);

  const set = (name: FieldName, value: string) => {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };
  const errorOf = (name: FieldName): string | undefined => {
    const code = errors[name];
    return code === undefined ? undefined : t(`error.${code}`);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = checkForm(form, slugEditable);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = bodyOf(form, slugEditable);
    const answer = editing
      ? await call.run<BrandWrap>('PUT', `${API_BRANDS}/${brand.id}`, {
          ...body,
          version: brand.version,
        })
      : await call.run<BrandWrap>('POST', API_BRANDS, body);
    if (!answer.ok) {
      if (answer.problem !== null) setErrors(fieldsOf(answer.problem.fields));
      return;
    }
    onSaved(answer.body.brand);
  }

  const problem = call.problem;
  const formId = 'brand-form';

  return (
    <Dialog
      open
      title={editing ? t('edit-title', { name: brand.name }) : t('new-title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onStale}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {editing ? t('save') : t('create')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {problem === null ? null : (
          <Banner tone="critical">
            <p>{tr(problem.key)}</p>
            {problem.similar.length === 0 ? null : (
              <ul className="mt-2 list-disc ps-5">
                {problem.similar.map((name) => (
                  <li key={name} className="break-words">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <TextField
          name="name"
          label={t('name')}
          value={form.name}
          maxLength={NAME_MAX}
          error={errorOf('name')}
          autoComplete="off"
          onChange={(event) => set('name', event.target.value)}
        />
        <TextField
          name="slug"
          label={t('slug')}
          help={slugEditable ? t('slug-help') : t('slug-locked')}
          prefix="/brands/"
          value={form.slug}
          disabled={!slugEditable}
          error={errorOf('slug')}
          autoComplete="off"
          onChange={(event) => set('slug', event.target.value)}
        />
        <TextAreaField
          name="summary"
          label={t('summary')}
          optionalLabel={t('optional')}
          value={form.summary}
          maxLength={SUMMARY_MAX}
          error={errorOf('summary')}
          onChange={(event) => set('summary', event.target.value)}
        />
        <TextField
          name="originCountry"
          label={t('origin')}
          help={t('origin-help')}
          optionalLabel={t('optional')}
          value={form.originCountry}
          maxLength={2}
          error={errorOf('originCountry')}
          autoComplete="off"
          onChange={(event) => set('originCountry', event.target.value.toUpperCase())}
        />
        <TextField
          name="logoImageId"
          label={t('logo')}
          help={t('image-help')}
          optionalLabel={t('optional')}
          value={form.logoImageId}
          error={errorOf('logoImageId')}
          autoComplete="off"
          onChange={(event) => set('logoImageId', event.target.value)}
        />
        <TextField
          name="logoAlt"
          label={t('logo-alt')}
          help={t('logo-alt-help')}
          optionalLabel={t('optional')}
          value={form.logoAlt}
          maxLength={ALT_MAX}
          error={errorOf('logoAlt')}
          autoComplete="off"
          onChange={(event) => set('logoAlt', event.target.value)}
        />
        <TextField
          name="headerImageId"
          label={t('header')}
          help={t('image-help')}
          optionalLabel={t('optional')}
          value={form.headerImageId}
          error={errorOf('headerImageId')}
          autoComplete="off"
          onChange={(event) => set('headerImageId', event.target.value)}
        />
      </form>
    </Dialog>
  );
}
