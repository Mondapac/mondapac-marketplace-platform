'use client';

import { Banner, Button, Card, FormActionBar, SkeletonRows, TextAreaField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { aboutProblemOf, type AboutProblem } from './errors.ts';
import type { StoreProfileView } from './types.ts';

/** Characters as a person counts them (code points), as the API does. */
const lengthOf = (text: string): number => [...text].length;

/** The name of a locale in the panel's language ("Japanese"), or the code when it has none. */
function languageName(code: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

type Status = 'idle' | 'saving' | 'saved' | 'reloading';

export function AboutCard({
  initial,
  csrfToken,
  canEdit,
}: {
  readonly initial: StoreProfileView;
  readonly csrfToken: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations();
  const uiLocale = useLocale();
  const { locales, aboutMaxLength } = initial;
  // The version the texts below were loaded at: a save names it, and a newer text elsewhere is a
  // conflict instead of being overwritten.
  const [base, setBase] = useState({ version: initial.version, about: initial.about });
  const [draft, setDraft] = useState<Record<string, string>>({ ...initial.about });
  const [status, setStatus] = useState<Status>('idle');
  const [problem, setProblem] = useState<AboutProblem | null>(null);
  const busy = useRef(false);

  const dirty = locales.some((locale) => (draft[locale] ?? '') !== (base.about[locale] ?? ''));
  const tooLong = locales.some((locale) => lengthOf(draft[locale] ?? '') > aboutMaxLength);

  function adopt(view: Pick<StoreProfileView, 'version' | 'about'>) {
    setBase({ version: view.version, about: view.about });
    setDraft({ ...view.about });
  }

  async function save() {
    if (busy.current || !dirty || tooLong) return;
    busy.current = true;
    setStatus('saving');
    setProblem(null);
    const about = Object.fromEntries(locales.map((locale) => [locale, draft[locale] ?? '']));
    const result = await callApi<StoreProfileView>(
      'PUT',
      'sellers/store-profile/about',
      { expectedVersion: base.version, about },
      csrfToken,
    );
    busy.current = false;
    if (result.ok) {
      adopt(result.body);
      setStatus('saved');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setStatus('idle');
    setProblem(aboutProblemOf(result.failure));
  }

  /** Throws away what is in the boxes and shows the text that is published now. */
  async function loadLatest() {
    if (busy.current) return;
    busy.current = true;
    setStatus('reloading');
    const result = await callApi<StoreProfileView>('GET', 'sellers/store-profile');
    busy.current = false;
    if (result.ok) {
      adopt(result.body);
      setProblem(null);
      setStatus('idle');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setStatus('idle');
    setProblem(aboutProblemOf(result.failure));
  }

  const banner = problem?.banner ?? null;

  return (
    <Card title={t('store-profile.about.title')}>
      <p className="text-sm text-fg-muted">
        {t('store-profile.about.help', { max: aboutMaxLength })}
      </p>
      {banner === null ? null : (
        <Banner tone="critical">
          {banner === 'throttled'
            ? t('store-profile.about.error.throttled', {
                seconds: problem?.retryAfterSeconds ?? 60,
              })
            : t(`store-profile.about.error.${banner}`)}
          {banner === 'stale' ? (
            <>
              {' '}
              <Button variant="link" onClick={() => void loadLatest()}>
                {t('store-profile.about.load-latest')}
              </Button>
            </>
          ) : null}
        </Banner>
      )}
      {status === 'reloading' ? (
        <SkeletonRows label={t('store-profile.about.loading')} rows={2} />
      ) : (
        locales.map((locale) => {
          const text = draft[locale] ?? '';
          const count = lengthOf(text);
          const rule = problem?.fields[locale];
          return (
            <TextAreaField
              key={locale}
              lang={locale}
              label={t('store-profile.about.field', { language: languageName(locale, uiLocale) })}
              value={text}
              rows={8}
              readOnly={!canEdit}
              onChange={(event) => {
                setDraft((current) => ({ ...current, [locale]: event.target.value }));
                if (status === 'saved') setStatus('idle');
                if (problem !== null) setProblem(null);
              }}
              error={
                rule !== undefined
                  ? t(`store-profile.about.rule.${rule}`, { max: aboutMaxLength })
                  : count > aboutMaxLength
                    ? t('store-profile.about.rule.length', { max: aboutMaxLength })
                    : undefined
              }
              counter={
                <span className={count > aboutMaxLength ? 'text-critical-fg' : undefined}>
                  {t('store-profile.about.counter', { count, max: aboutMaxLength })}
                </span>
              }
            />
          );
        })
      )}
      {canEdit ? (
        <FormActionBar
          // Always in the page, so a screen reader hears the text when it is put in.
          status={
            <span role="status">
              {status === 'saved'
                ? t('store-profile.about.saved')
                : status === 'saving'
                  ? t('store-profile.about.saving')
                  : null}
            </span>
          }
        >
          <Button
            onClick={() => void save()}
            disabled={!dirty || tooLong || status === 'reloading'}
            loading={status === 'saving'}
          >
            {status === 'saving' ? t('store-profile.about.saving') : t('store-profile.about.save')}
          </Button>
        </FormActionBar>
      ) : null}
    </Card>
  );
}
