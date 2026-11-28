'use client';

import { Button, Card, FormActionBar, SearchSelect, type SearchSelectOption } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useFocusFirstInvalid } from '../auth/use-focus-first-invalid.ts';
import { ButtonLink } from './button-link.tsx';
import { ProblemBanner } from './problem-banner.tsx';
import { nextHref, SETUP_ROOT } from './steps.ts';
import { MAX_EXTRA_ACTIVITIES, type ActivityChoice, type MyFile } from './types.ts';
import { useStepSave } from './use-step-save.ts';
import { useWithdrawGuard } from './use-withdraw-guard.tsx';

/** The activity's name in the seller's language, else the Market's default, else its code. */
export function activityName(
  choice: ActivityChoice,
  locale: string,
  defaultLocale: string,
): string {
  return (
    choice.names[locale] ??
    choice.names[defaultLocale] ??
    Object.values(choice.names)[0] ??
    choice.code
  );
}

/**
 * S2b: the seller asks for one main business activity and up to nine more (BUG-012 step 2). It is
 * a request: the reviewer confirms or changes it before approval, so nothing here changes the
 * seller's own scope. Both pickers search the list in the browser (the Market holds a short list).
 */
export function ActivityForm({
  file,
  csrfToken,
  choices,
  locale,
  defaultLocale,
  initialMain,
  initialExtras,
}: {
  readonly file: MyFile;
  readonly csrfToken: string;
  readonly choices: readonly ActivityChoice[];
  readonly locale: string;
  readonly defaultLocale: string;
  readonly initialMain: string | null;
  readonly initialExtras: readonly string[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [main, setMain] = useState<string | null>(initialMain);
  const [extras, setExtras] = useState<readonly string[]>(initialExtras);
  const [initial] = useState(JSON.stringify([initialMain, initialExtras]));
  const { pending, problem, save, focusKeys } = useStepSave(csrfToken);
  const guard = useWithdrawGuard(file.status === 'awaiting-review');
  useFocusFirstInvalid(formRef, focusKeys);

  const options = useMemo<SearchSelectOption[]>(
    () =>
      choices
        .map((choice) => ({
          value: choice.id,
          label: activityName(choice, locale, defaultLocale),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [choices, locale, defaultLocale],
  );
  const optionOf = (id: string): SearchSelectOption =>
    options.find((option) => option.value === id) ?? { value: id, label: id };

  const labels = {
    search: t('sellers.activity.labels.search'),
    noResults: t('sellers.activity.labels.no-results'),
    loading: t('sellers.activity.labels.loading'),
    retry: t('sellers.activity.labels.retry'),
    remove: (name: string) => t('sellers.activity.labels.remove', { name }),
    limitReached: (max: number) => t('sellers.activity.labels.limit-reached', { max }),
    none: t('sellers.activity.labels.none'),
  };
  const fieldError = (path: string): string | undefined => {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key);
  };
  const extrasError =
    Object.entries(problem?.fields ?? {}).find(([path]) => path.startsWith('extraActivityIds')) ??
    null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (main === null) {
      // A request needs a main activity; with none chosen the seller may continue without one.
      router.push(nextHref('activity'));
      return;
    }
    const changed = JSON.stringify([main, extras]) !== initial;
    void guard.run(changed, persist);
  }

  async function persist() {
    if (main === null) return;
    const result = await save('sellers/my-file/activities', {
      mainActivityId: main,
      extraActivityIds: extras.filter((id) => id !== main),
    });
    if (result?.ok) {
      router.push(nextHref('activity'));
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
      <Card title={t('sellers.activity.title')}>
        <p className="text-sm text-fg-muted">
          {t('sellers.activity.intro', { max: MAX_EXTRA_ACTIVITIES })}
        </p>
        {options.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('sellers.activity.none-available')}</p>
        ) : (
          <>
            <SearchSelect
              name="mainActivityId"
              label={t('sellers.activity.main.label')}
              placeholder={t('sellers.activity.main.placeholder')}
              error={fieldError('mainActivityId')}
              options={options}
              value={main === null ? null : optionOf(main)}
              alwaysSearch
              labels={labels}
              onChange={(next) => {
                setMain(next === null ? null : next.value);
                // The main activity is never also an extra.
                if (next !== null)
                  setExtras((current) => current.filter((id) => id !== next.value));
              }}
            />
            <SearchSelect
              multiple
              name="extraActivityIds"
              label={t('sellers.activity.extra.label')}
              placeholder={t('sellers.activity.extra.placeholder')}
              help={t('sellers.activity.extra.help', { max: MAX_EXTRA_ACTIVITIES })}
              error={extrasError === null ? undefined : t(extrasError[1])}
              options={options.filter((option) => option.value !== main)}
              value={extras.map(optionOf)}
              max={MAX_EXTRA_ACTIVITIES}
              alwaysSearch
              labels={labels}
              onChange={(next) => setExtras(next.map((option) => option.value))}
            />
          </>
        )}
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
