'use client';

import {
  Banner,
  SettingRow,
  SettingsConflictBanner,
  SettingsErrorSummary,
  SettingsSection,
  SettingTextArea,
  SkeletonRows,
  toast,
  type SettingsErrorItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
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

type Status = 'idle' | 'saving' | 'reloading';

const rowId = (locale: string) => `setting-about-${locale}`;

/**
 * The About text of the store profile: one draft per locale, saved with the version it loaded.
 * The page owns the save bar, so this keeps the state and gives the page what it shows.
 */
export function useAbout({
  initial,
  csrfToken,
}: {
  readonly initial: StoreProfileView;
  readonly csrfToken: string;
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
  const [failedSaves, setFailedSaves] = useState(0);
  const busy = useRef(false);

  const changed = (locale: string) => (draft[locale] ?? '') !== (base.about[locale] ?? '');
  const count = locales.filter(changed).length;
  const errorOf = (locale: string): string | undefined => {
    const rule = problem?.fields[locale];
    if (rule !== undefined) return t(`store-profile.about.rule.${rule}`, { max: aboutMaxLength });
    return lengthOf(draft[locale] ?? '') > aboutMaxLength
      ? t('store-profile.about.rule.length', { max: aboutMaxLength })
      : undefined;
  };
  const invalid = locales.filter((locale) => errorOf(locale) !== undefined);

  function adopt(view: Pick<StoreProfileView, 'version' | 'about'>) {
    setBase({ version: view.version, about: view.about });
    setDraft({ ...view.about });
  }

  async function save() {
    if (busy.current || count === 0 || invalid.length > 0) return;
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
      setStatus('idle');
      toast.success(t('store-profile.about.saved'));
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setStatus('idle');
    const next = aboutProblemOf(result.failure);
    setProblem(next);
    if (Object.keys(next.fields).length > 0) setFailedSaves((n) => n + 1);
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

  function discard() {
    setDraft({ ...base.about });
    setProblem(null);
  }

  const label = (locale: string) =>
    t('store-profile.about.field', { language: languageName(locale, uiLocale) });
  const banner = problem?.banner ?? null;
  const errorItems: SettingsErrorItem[] = invalid.map((locale) => ({
    id: rowId(locale),
    label: label(locale),
  }));

  /** The conflict, the error summary and the other problems, for the page's banner slot. */
  const banners: ReactNode[] = [
    invalid.length === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: invalid.length })}
        items={errorItems}
        focusSignal={failedSaves}
      />
    ),
    banner === 'stale' ? (
      <SettingsConflictBanner
        key="stale"
        title={t('store-profile.about.conflict-title')}
        body={t('store-profile.about.error.stale')}
        compareLabel={t('store-profile.about.load-latest')}
        onCompare={() => void loadLatest()}
      />
    ) : null,
    banner === null || banner === 'stale' ? null : (
      <Banner key="problem" tone="critical">
        {banner === 'throttled'
          ? t('store-profile.about.error.throttled', {
              seconds: problem?.retryAfterSeconds ?? 60,
            })
          : t(`store-profile.about.error.${banner}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return {
    dirty: count > 0,
    count,
    errorCount: invalid.length,
    saving: status === 'saving',
    banners,
    save,
    discard,
    section: (canEdit: boolean) => (
      <AboutSection
        locales={locales}
        draft={draft}
        reloading={status === 'reloading'}
        max={aboutMaxLength}
        canEdit={canEdit}
        label={label}
        changed={changed}
        errorOf={errorOf}
        onChange={(locale, text) => {
          setDraft((current) => ({ ...current, [locale]: text }));
          if (problem !== null) setProblem(null);
        }}
      />
    ),
  };
}

function AboutSection({
  locales,
  draft,
  reloading,
  max,
  canEdit,
  label,
  changed,
  errorOf,
  onChange,
}: {
  readonly locales: readonly string[];
  readonly draft: Readonly<Record<string, string>>;
  readonly reloading: boolean;
  readonly max: number;
  readonly canEdit: boolean;
  readonly label: (locale: string) => string;
  readonly changed: (locale: string) => boolean;
  readonly errorOf: (locale: string) => string | undefined;
  readonly onChange: (locale: string, text: string) => void;
}) {
  const t = useTranslations();
  return (
    <SettingsSection
      title={t('store-profile.about.title')}
      description={t('store-profile.about.help', { max })}
    >
      {reloading ? (
        <div className="px-5 py-4">
          <SkeletonRows label={t('store-profile.about.loading')} rows={2} />
        </div>
      ) : (
        locales.map((locale) => {
          const text = draft[locale] ?? '';
          const count = lengthOf(text);
          return (
            <SettingRow
              key={locale}
              id={rowId(locale)}
              label={label(locale)}
              changed={changed(locale)}
              disabled={!canEdit}
              error={errorOf(locale)}
            >
              <SettingTextArea
                lang={locale}
                dir="auto"
                value={text}
                rows={8}
                onChange={(event) => onChange(locale, event.target.value)}
                counter={
                  <span className={count > max ? 'text-critical-fg' : undefined}>
                    {t('store-profile.about.counter', { count, max })}
                  </span>
                }
              />
            </SettingRow>
          );
        })
      )}
    </SettingsSection>
  );
}
