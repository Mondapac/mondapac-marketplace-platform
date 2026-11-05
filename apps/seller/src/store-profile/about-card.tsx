'use client';

import {
  Banner,
  SettingRow,
  SettingsErrorSummary,
  SettingsSection,
  SettingTextArea,
  toast,
  useLiveErrors,
  useSettingsForm,
  type FieldChange,
  type SaveResult,
  type SettingsErrorItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { SettingsConflictView } from '../settings/conflict-view.tsx';
import { claimsCertification } from './claim-terms.ts';
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

/** What the form holds as saved: the About texts and the version they were saved at. */
type Saved = Pick<StoreProfileView, 'version' | 'about'>;

const STORE_PROFILE_PATH = 'sellers/store-profile';
const savedOf = (view: StoreProfileView): Saved => ({ version: view.version, about: view.about });
const toDraft = (saved: Saved): Record<string, string> => ({ ...saved.about });
const versionOf = (saved: Saved) => saved.version;
async function reload(): Promise<Saved | null> {
  const fresh = await callApi<StoreProfileView>('GET', STORE_PROFILE_PATH);
  return fresh.ok ? savedOf(fresh.body) : null;
}

const rowId = (locale: string) => `setting-about-${locale}`;

/**
 * The About text of the store profile: one draft per locale, saved with the version it loaded.
 * The page owns the save bar, so this keeps the state and gives the page what it shows.
 */
export function useAbout({
  initial,
  csrfToken,
  claimTerms = [],
}: {
  readonly initial: StoreProfileView;
  readonly csrfToken: string;
  readonly claimTerms?: readonly string[];
}) {
  const t = useTranslations();
  const uiLocale = useLocale();
  const { locales, aboutMaxLength } = initial;
  const [problem, setProblem] = useState<AboutProblem | null>(null);
  const [refusals, setRefusals] = useState(0);
  const label = (locale: string) =>
    t('store-profile.about.field', { language: languageName(locale, uiLocale) });
  const empty = t('settings.conflict.unset');
  // The version the texts were loaded at: a save names it, and a newer text elsewhere is a
  // conflict that keeps these drafts and lists, per locale, what is saved now and what is typed.
  const form = useSettingsForm<Saved, Record<string, string>>({
    initial: savedOf(initial),
    toDraft,
    versionOf,
    reload,
    changes: (saved, draft): readonly FieldChange[] =>
      locales
        .filter((locale) => (draft[locale] ?? '') !== (saved.about[locale] ?? ''))
        .map((locale) => ({
          key: locale,
          label: label(locale),
          saved: saved.about[locale] || empty,
          yours: draft[locale] || empty,
        })),
  });
  const draft = form.draft;
  const base = form.saved;

  const changed = (locale: string) => (draft[locale] ?? '') !== (base.about[locale] ?? '');
  const count = form.count;
  // The rule a text breaks right now, worked out here as it is typed: too long, or wording that
  // claims a certification (the terms come from the API; the save check stays the authority).
  const ruleNow = (locale: string): 'length' | 'claim-term' | undefined => {
    const text = draft[locale] ?? '';
    if (lengthOf(text) > aboutMaxLength) return 'length';
    return claimsCertification(text, claimTerms) ? 'claim-term' : undefined;
  };
  const live = useLiveErrors<string>(locales.filter((locale) => ruleNow(locale) !== undefined));
  const errorOf = (locale: string): string | undefined => {
    // What the server refused outranks the live reading until the text is edited again.
    const rule = problem?.fields[locale] ?? (live.has(locale) ? ruleNow(locale) : undefined);
    return rule === undefined
      ? undefined
      : t(`store-profile.about.rule.${rule}`, { max: aboutMaxLength });
  };
  const invalid = locales.filter((locale) => errorOf(locale) !== undefined);

  async function save() {
    if (form.saving || count === 0) return;
    if (locales.some((locale) => ruleNow(locale) !== undefined)) {
      live.attempt();
      return;
    }
    if (invalid.length > 0) return;
    setProblem(null);
    const about = Object.fromEntries(locales.map((locale) => [locale, draft[locale] ?? '']));
    const result = await form.run(async (expectedVersion): Promise<SaveResult<Saved>> => {
      const reply = await callApi<StoreProfileView>(
        'PUT',
        'sellers/store-profile/about',
        { expectedVersion, about },
        csrfToken,
      );
      if (reply.ok) return { status: 'saved', saved: savedOf(reply.body) };
      if (reply.failure.status === 401) {
        window.location.assign('/session-ended');
        return { status: 'failed' };
      }
      const next = aboutProblemOf(reply.failure);
      if (next.banner === 'stale') return { status: 'conflict' };
      setProblem(next);
      if (Object.keys(next.fields).length > 0) setRefusals((n) => n + 1);
      return { status: 'failed' };
    });
    if (result.status === 'saved') {
      live.reset();
      toast.success(t('store-profile.about.saved'));
    }
    // The re-read failed too: the plain "reload the page" message is all that is left.
    else if (result.status === 'conflict' && result.reloaded === false) {
      setProblem({ banner: 'stale', fields: {} });
    }
  }

  function discard() {
    form.discard();
    live.reset();
    setProblem(null);
  }

  const banner = problem?.banner ?? null;
  const errorItems: SettingsErrorItem[] = invalid.map((locale) => ({
    id: rowId(locale),
    label: label(locale),
    reason: errorOf(locale),
  }));

  /** The conflict, the error summary and the other problems, for the page's banner slot. */
  const banners: ReactNode[] = [
    invalid.length === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: invalid.length })}
        items={errorItems}
        focusSignal={live.attempts + refusals}
      />
    ),
    form.theirs === null ? null : (
      <SettingsConflictView key="conflict" conflictId={form.conflictId} changes={form.changes} />
    ),
    banner === null ? null : (
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
    saving: form.saving,
    banners,
    save,
    discard,
    section: (canEdit: boolean) => (
      <AboutSection
        locales={locales}
        draft={draft}
        max={aboutMaxLength}
        canEdit={canEdit}
        label={label}
        changed={changed}
        errorOf={errorOf}
        onChange={(locale, text) => {
          form.setDraft((current) => ({ ...current, [locale]: text }));
          live.touch(locale);
          if (problem !== null) setProblem(null);
        }}
        onLeave={live.touch}
      />
    ),
  };
}

function AboutSection({
  locales,
  draft,
  max,
  canEdit,
  label,
  changed,
  errorOf,
  onChange,
  onLeave,
}: {
  readonly locales: readonly string[];
  readonly draft: Readonly<Record<string, string>>;
  readonly max: number;
  readonly canEdit: boolean;
  readonly label: (locale: string) => string;
  readonly changed: (locale: string) => boolean;
  readonly errorOf: (locale: string) => string | undefined;
  readonly onChange: (locale: string, text: string) => void;
  readonly onLeave: (locale: string) => void;
}) {
  const t = useTranslations();
  return (
    <SettingsSection
      title={t('store-profile.about.title')}
      description={t('store-profile.about.help', { max })}
    >
      {locales.map((locale) => {
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
              onBlur={() => onLeave(locale)}
              counter={
                <span className={count > max ? 'text-critical-fg' : undefined}>
                  {t('store-profile.about.counter', { count, max })}
                </span>
              }
            />
          </SettingRow>
        );
      })}
    </SettingsSection>
  );
}
