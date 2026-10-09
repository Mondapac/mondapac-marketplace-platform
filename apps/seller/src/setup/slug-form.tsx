'use client';

import { Button, Card, FieldStatus, FormActionBar, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { useFocusFirstInvalid } from '../auth/use-focus-first-invalid.ts';
import { SLUG_MAX, SLUG_MIN, slugFormatOk, suggestSlug } from './slug.ts';
import { nextHref, SETUP_ROOT } from './steps.ts';
import type { DraftSaved, MyFile, SlugCheck } from './types.ts';
import { ButtonLink } from './button-link.tsx';
import { ProblemBanner } from './problem-banner.tsx';
import { useStepSave } from './use-step-save.ts';
import { useWithdrawGuard } from './use-withdraw-guard.tsx';

const IDLE_MS = 600;

type CheckState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'done'; readonly slug: string; readonly code: string }
  | { readonly kind: 'failed'; readonly throttled: boolean };

export function SlugForm({
  file,
  csrfToken,
  storefrontAddress,
}: {
  readonly file: MyFile;
  readonly csrfToken: string;
  readonly storefrontAddress: string | null;
}) {
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  const suggestion = file.slug === null ? suggestSlug(file.general.storeName ?? '') : '';
  const [value, setValue] = useState(file.slug ?? suggestion);
  const [suggested, setSuggested] = useState(file.slug === null && suggestion !== '');
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const [savedOnce, setSavedOnce] = useState(file.slug !== null);
  const { pending, problem, save, focusKeys } = useStepSave(csrfToken);
  const guard = useWithdrawGuard(file.status === 'awaiting-review');
  useFocusFirstInvalid(formRef, focusKeys);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  const limits = { min: SLUG_MIN, max: SLUG_MAX };

  async function runCheck(slug: string) {
    if (!slugFormatOk(slug) || slug === file.slug) {
      setCheck({ kind: 'idle' });
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setCheck({ kind: 'checking' });
    const result = await callApi<SlugCheck>(
      'POST',
      'sellers/my-file/slug-check',
      { slug },
      csrfToken,
    );
    inFlight.current = false;
    if (latest.current !== slug) {
      // The seller kept typing while the request ran: check the newer value.
      void runCheck(latest.current);
      return;
    }
    setCheck(
      result.ok
        ? { kind: 'done', slug, code: result.body.code }
        : { kind: 'failed', throttled: result.failure.code === 'request.throttled' },
    );
  }

  function scheduleCheck(slug: string) {
    if (timer.current) clearTimeout(timer.current);
    setCheck({ kind: 'idle' });
    if (!slugFormatOk(slug)) return;
    timer.current = setTimeout(() => void runCheck(slug), IDLE_MS);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function onChange(next: string) {
    setValue(next);
    setSuggested(false);
    scheduleCheck(next);
  }

  function onBlur() {
    if (timer.current) clearTimeout(timer.current);
    void runCheck(value);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void guard.run(value !== (file.slug ?? ''), persist);
  }

  async function persist() {
    if (timer.current) clearTimeout(timer.current);
    const outcome = await save<DraftSaved>('sellers/my-file/slug', { slug: value });
    if (outcome?.ok) {
      setSavedOnce(true);
      setCheck({ kind: 'idle' });
    }
  }

  const localInvalid = value !== '' && !slugFormatOk(value);
  const failure = problem?.fields['slug'];
  const checkedCode = check.kind === 'done' && check.slug === value ? check.code : null;
  let status;
  if (failure !== undefined || localInvalid) {
    status = undefined;
  } else if (check.kind === 'checking') {
    status = <FieldStatus tone="checking">{t('sellers.slug.status.checking')}</FieldStatus>;
  } else if (checkedCode === 'slug.available') {
    status = <FieldStatus tone="success">{t('sellers.slug.status.available')}</FieldStatus>;
  } else if (check.kind === 'failed') {
    status = (
      <FieldStatus tone={check.throttled ? 'critical' : 'info'}>
        {t(check.throttled ? 'sellers.slug.status.throttled' : 'sellers.slug.status.failed')}
      </FieldStatus>
    );
  } else if (checkedCode === 'slug.format') {
    status = <FieldStatus tone="critical">{t('sellers.error.slug.format', limits)}</FieldStatus>;
  } else if (checkedCode === 'slug.taken' || checkedCode === 'slug.reserved') {
    status = <FieldStatus tone="critical">{t(`sellers.error.${checkedCode}`)}</FieldStatus>;
  }
  const error =
    failure !== undefined
      ? t(failure, limits)
      : localInvalid
        ? t('sellers.error.slug.format', limits)
        : undefined;
  const canSave =
    value !== '' &&
    !localInvalid &&
    checkedCode !== 'slug.taken' &&
    checkedCode !== 'slug.reserved';
  const help = `${t('sellers.slug.help', limits)} ${t('sellers.slug.help-later')}`;

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
      <Card>
        <TextField
          name="slug"
          label={t('sellers.slug.label')}
          {...(storefrontAddress === null ? {} : { prefix: storefrontAddress })}
          help={help}
          status={status}
          error={error}
          value={value}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          onBlur={onBlur}
          maxLength={SLUG_MAX}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
        />
        {suggested ? <p className="text-sm text-fg-muted">{t('sellers.slug.suggested')}</p> : null}
      </Card>
      <FormActionBar status={savedOnce && !problem && !pending ? t('sellers.status.saved') : null}>
        <ButtonLink href={SETUP_ROOT} variant="secondary">
          {t('sellers.action.back-to-checklist')}
        </ButtonLink>
        <Button
          type="submit"
          variant={savedOnce ? 'secondary' : 'primary'}
          loading={pending}
          disabled={!canSave}
        >
          {t(
            pending
              ? 'sellers.action.saving'
              : savedOnce
                ? 'sellers.action.save'
                : 'sellers.action.save-continue',
          )}
        </Button>
        {savedOnce ? (
          <ButtonLink href={nextHref('slug')} variant="primary">
            {t('sellers.action.continue')}
          </ButtonLink>
        ) : null}
      </FormActionBar>
    </form>
  );
}
