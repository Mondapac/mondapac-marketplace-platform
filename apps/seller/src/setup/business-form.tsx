'use client';

import { Button, Card, FormActionBar, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { useFocusFirstInvalid } from '../auth/use-focus-first-invalid.ts';
import { nextHref, SETUP_ROOT } from './steps.ts';
import type { DraftSaved, MyFile } from './types.ts';
import { ButtonLink } from './button-link.tsx';
import { ProblemBanner } from './problem-banner.tsx';
import { useStepSave } from './use-step-save.ts';
import { useWithdrawGuard } from './use-withdraw-guard.tsx';

export function BusinessForm({
  file,
  csrfToken,
  signInEmail,
  phoneMaxLength,
}: {
  readonly file: MyFile;
  readonly csrfToken: string;
  readonly signInEmail: string;
  readonly phoneMaxLength: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({
    storeName: file.general.storeName ?? '',
    businessName: file.general.businessName ?? '',
    phone: file.general.phone ?? '',
    contactEmail: file.general.contactEmail ?? '',
  });
  const [initial] = useState(values);
  const { pending, problem, save, focusKeys } = useStepSave(csrfToken);
  const guard = useWithdrawGuard(file.status === 'awaiting-review');
  const fieldKey = (name: keyof typeof values) => problem?.fields[name];
  const fieldError = (name: keyof typeof values) => {
    const key = fieldKey(name);
    return key === undefined ? undefined : t(key);
  };
  useFocusFirstInvalid(formRef, focusKeys);

  function set(name: keyof typeof values) {
    return (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [name]: event.target.value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void guard.run(JSON.stringify(values) !== JSON.stringify(initial), persist);
  }

  async function persist() {
    const result = await save<DraftSaved>('sellers/my-file/general', values);
    if (result?.ok) {
      router.push(nextHref('business'));
      router.refresh();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      {guard.banner}
      {guard.dialog}
      {problem?.form ? <ProblemBanner message={t(problem.form.key)} /> : null}
      <Card title={t('sellers.business.title')}>
        <TextField
          name="storeName"
          label={t('sellers.business.label.store-name')}
          help={t('sellers.business.help.store-name')}
          error={fieldError('storeName')}
          value={values.storeName}
          onChange={set('storeName')}
          maxLength={100}
          autoComplete="organization"
        />
        <TextField
          name="businessName"
          label={t('sellers.business.label.business-name')}
          help={t('sellers.business.help.business-name')}
          error={fieldError('businessName')}
          value={values.businessName}
          onChange={set('businessName')}
        />
        <TextField
          name="phone"
          type="tel"
          label={t('sellers.business.label.phone')}
          error={fieldError('phone')}
          value={values.phone}
          onChange={set('phone')}
          maxLength={phoneMaxLength}
          autoComplete="tel"
          dir="ltr"
        />
        <TextField
          name="contactEmail"
          type="email"
          label={t('sellers.business.label.contact-email')}
          optionalLabel={t('sellers.optional')}
          help={t('sellers.business.help.contact-email', { signInEmail })}
          error={fieldError('contactEmail')}
          value={values.contactEmail}
          onChange={set('contactEmail')}
          autoComplete="email"
          dir="ltr"
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">
            {t('sellers.business.label.sign-in-email')}
          </span>
          <span dir="ltr" className="text-fg">
            {signInEmail}
          </span>
        </div>
      </Card>
      <FormActionBar>
        <ButtonLink href={SETUP_ROOT} variant="secondary">
          {t('sellers.action.back-to-checklist')}
        </ButtonLink>
        <Button type="submit" loading={pending}>
          {t(pending ? 'sellers.action.saving' : 'sellers.action.save-continue')}
        </Button>
      </FormActionBar>
    </form>
  );
}
