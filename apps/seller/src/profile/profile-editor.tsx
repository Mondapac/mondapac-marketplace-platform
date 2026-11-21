'use client';

import {
  Banner,
  Card,
  SaveBar,
  Select,
  TextField,
  toast,
  useSectionSaves,
  useUnsavedChangesGuard,
  type SectionResult,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { PANEL_LANGUAGES } from './languages.ts';
import { nameProblemOf, preferencesProblemOf, type Problem } from './errors.ts';

const MAX_LENGTH = 100;

interface Preferences {
  readonly zone: string;
  readonly language: string;
}

/**
 * The signed-in user's own display name, time zone and language under one save bar. The name
 * and the preferences are separate API resources: Save sends each part that changed, in turn,
 * and a part that fails keeps its edits and its message while the other still saves. The
 * password has its own card and button outside this form.
 */
export function ProfileEditor({
  name: initialName,
  timezone,
  locale,
  zones,
  csrfToken,
}: {
  readonly name: string;
  readonly timezone: string | null;
  readonly locale: string | null;
  /** IANA zone ids, read on the server so the list is the same on both sides. */
  readonly zones: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('profile');
  const tr = useTranslations();
  const router = useRouter();
  const [savedName, setSavedName] = useState(initialName);
  const [name, setName] = useState(initialName);
  const [savedPrefs, setSavedPrefs] = useState<Preferences>({
    zone: timezone ?? '',
    language: locale ?? '',
  });
  const [zone, setZone] = useState(savedPrefs.zone);
  const [language, setLanguage] = useState(savedPrefs.language);
  const [nameProblem, setNameProblem] = useState<Problem | null>(null);
  const [prefsProblem, setPrefsProblem] = useState<Problem | null>(null);
  const [leaving, setLeaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // A part the server really changed: the page then reloads what the server shows.
  const changed = useRef(false);

  const nameDirty = name !== savedName;
  const prefsDirty = zone !== savedPrefs.zone || language !== savedPrefs.language;

  function signedOut(): SectionResult {
    flushSync(() => setLeaving(true));
    window.location.assign('/session-ended');
    return 'stopped';
  }

  async function saveName(): Promise<SectionResult> {
    setNameProblem(null);
    const trimmed = name.trim();
    if (trimmed === '' || [...trimmed].length > MAX_LENGTH) {
      setNameProblem({ key: 'name-length', field: 'name' });
      return 'failed';
    }
    const result = await callApi<{ readonly changed: boolean }>(
      'PUT',
      'identity/seller/profile/display-name',
      { displayName: trimmed },
      csrfToken,
    );
    if (result.ok) {
      setName(trimmed);
      setSavedName(trimmed);
      if (result.body.changed) changed.current = true;
      if (result.body.changed) toast.success(t('name-saved'));
      else toast.info(t('name-same'));
      return 'saved';
    }
    if (result.failure.status === 401) return signedOut();
    setNameProblem(nameProblemOf(result.failure));
    return 'failed';
  }

  async function savePrefs(): Promise<SectionResult> {
    setPrefsProblem(null);
    const result = await callApi<{ readonly changed: boolean }>(
      'PUT',
      'identity/seller/profile/preferences',
      { timezone: zone === '' ? null : zone, locale: language === '' ? null : language },
      csrfToken,
    );
    if (result.ok) {
      setSavedPrefs({ zone, language });
      if (result.body.changed) changed.current = true;
      if (result.body.changed) toast.success(t('prefs-saved'));
      else toast.info(t('prefs-same'));
      return 'saved';
    }
    if (result.failure.status === 401) return signedOut();
    setPrefsProblem(preferencesProblemOf(result.failure));
    return 'failed';
  }

  const sections = useSectionSaves([
    { key: 'name', dirty: nameDirty, save: saveName },
    { key: 'preferences', dirty: prefsDirty, save: savePrefs },
  ]);

  const guard = useUnsavedChangesGuard(
    sections.count > 0 && !leaving,
    {
      title: tr('settings.leave.title'),
      message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
      stay: tr('settings.leave.stay'),
      leave: tr('settings.leave.leave'),
    },
    { count: sections.count, page: t('title') },
  );

  async function submit() {
    changed.current = false;
    const run = await sections.saveAll();
    if (run === null || run.stopped) return;
    // The details card and the account menu read these on the server.
    if (changed.current) router.refresh();
    if (run.failed.length > 0) {
      queueMicrotask(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    }
  }

  function discard() {
    setName(savedName);
    setZone(savedPrefs.zone);
    setLanguage(savedPrefs.language);
    setNameProblem(null);
    setPrefsProblem(null);
  }

  const nameError = nameProblem?.field === 'name' ? t(`error.${nameProblem.key}`) : undefined;
  return (
    <form
      ref={formRef}
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Card title={t('name-title')}>
        <div className="flex flex-col gap-4 sm:max-w-md">
          {nameProblem === null || nameProblem.field !== null ? null : (
            <Banner tone="critical">{t(`error.${nameProblem.key}`, nameProblem.values)}</Banner>
          )}
          <TextField
            name="displayName"
            label={t('name-label')}
            help={t('name-help')}
            autoComplete="name"
            // Twice the limit: the limit counts characters, the browser counts UTF-16 units.
            maxLength={MAX_LENGTH * 2}
            value={name}
            error={nameError}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </Card>
      <Card title={t('prefs-title')}>
        <div className="flex flex-col gap-4 sm:max-w-md">
          <p className="text-sm text-fg-muted">{t('prefs-intro-seller')}</p>
          {prefsProblem === null ? null : (
            <Banner tone="critical">{t(`error.${prefsProblem.key}`, prefsProblem.values)}</Banner>
          )}
          <Select
            name="timezone"
            label={t('timezone-label')}
            help={t('timezone-help-seller')}
            value={zone}
            options={[
              { value: '', label: t('timezone-default-seller') },
              ...zones.map((id) => ({ value: id, label: id.replaceAll('_', ' ') })),
            ]}
            onChange={(event) => setZone(event.target.value)}
          />
          <Select
            name="locale"
            label={t('language-label')}
            help={t('language-help')}
            value={language}
            options={[
              { value: '', label: t('language-default') },
              ...PANEL_LANGUAGES.map((code) => ({ value: code, label: t(`language-${code}`) })),
            ]}
            onChange={(event) => setLanguage(event.target.value)}
          />
        </div>
      </Card>
      <SaveBar
        count={sections.count}
        summary={tr('settings.bar.summary', { count: sections.count })}
        saving={sections.saving}
        aboveBottomBar
        labels={{
          region: tr('settings.bar.region'),
          discard: tr('settings.bar.discard'),
          save: tr('settings.bar.save'),
          saving: tr('settings.bar.saving'),
        }}
        onDiscard={discard}
      />
      {sections.count > 0 ? guard.dialog : null}
    </form>
  );
}
