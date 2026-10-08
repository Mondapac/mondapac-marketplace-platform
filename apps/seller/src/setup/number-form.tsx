'use client';

import { Button, Card, FieldStatus, FormActionBar, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useFocusFirstInvalid } from '../auth/use-focus-first-invalid.ts';
import { nextHref } from './steps.ts';
import type { FormDescriptors, IdentifierSaved, MyFile, RegisterResult } from './types.ts';
import { ProblemBanner } from './problem-banner.tsx';
import { useStepSave } from './use-step-save.ts';

const RESULT_KEY: Record<RegisterResult, { tone: 'success' | 'critical' | 'info'; key: string }> = {
  matched: { tone: 'success', key: 'sellers.number.status.matched' },
  'not-matched': { tone: 'critical', key: 'sellers.number.status.not-matched' },
  'could-not-be-checked': { tone: 'info', key: 'sellers.number.status.unavailable' },
};

export function NumberForm({
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
  const { labelKey, required, maxLength, scheme } = descriptors.identifier;
  const identifierLabel = t.has(labelKey) ? t(labelKey) : t('sellers.number.title');
  const helpKey = `sellers.number.help.${scheme}`;
  const [value, setValue] = useState(file.identifier?.display ?? '');
  const [registerResult, setRegisterResult] = useState<RegisterResult | null>(file.registerResult);
  const [savedOnce, setSavedOnce] = useState(file.identifier !== null);
  const { pending, problem, save, focusKeys } = useStepSave(csrfToken);
  useFocusFirstInvalid(formRef, focusKeys);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const outcome = await save<IdentifierSaved>('sellers/my-file/identifier', {
      identifier: value.trim() === '' ? null : value,
    });
    if (outcome?.ok) {
      setRegisterResult(outcome.body.registerResult);
      setSavedOnce(true);
    }
  }

  const failure = problem?.fields['identifier'];
  const status = pending ? (
    <FieldStatus tone="checking">{t('sellers.number.status.checking')}</FieldStatus>
  ) : failure === undefined && registerResult ? (
    <FieldStatus tone={RESULT_KEY[registerResult].tone}>
      {t(RESULT_KEY[registerResult].key)}
    </FieldStatus>
  ) : undefined;

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      {problem?.form ? <ProblemBanner message={t(problem.form.key)} /> : null}
      <Card>
        <TextField
          name="identifier"
          label={identifierLabel}
          optionalLabel={required ? undefined : t('sellers.optional')}
          help={t.has(helpKey) ? t(helpKey) : undefined}
          error={failure === undefined ? undefined : t(failure, { identifierLabel })}
          status={status}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={maxLength}
          inputMode={scheme === 'abn' ? 'numeric' : 'text'}
          autoComplete="off"
          dir="ltr"
        />
      </Card>
      <FormActionBar status={savedOnce && !problem && !pending ? t('sellers.status.saved') : null}>
        <Button type="submit" variant={savedOnce ? 'secondary' : 'primary'} loading={pending}>
          {t(
            pending
              ? 'sellers.action.saving'
              : savedOnce
                ? 'sellers.action.save'
                : 'sellers.action.save-continue',
          )}
        </Button>
        {savedOnce ? (
          <Link
            href={nextHref('number')}
            className="inline-flex h-(--mp-size-control) items-center rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover"
          >
            {t('sellers.action.continue')}
          </Link>
        ) : null}
      </FormActionBar>
    </form>
  );
}
