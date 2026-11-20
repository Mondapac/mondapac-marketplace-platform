'use client';

import { Banner, Button, Select, SettingsDrawer, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { useDrawerLabels } from '../settings/drawer-labels.ts';
import { areaProblemOf, languageLabel } from './errors.ts';
import {
  AREA_NAME_MAX,
  AREA_NAMES_PATH,
  type AreaNames,
  type AreaNamesEdited,
  type AreaRow,
} from './types.ts';

/** Edit, in the settings drawer, the names of one area, one language at a time (POST sellers/admin/service-areas/names). */
export function EditNamesDialog({
  area,
  config,
  csrfToken,
  onClose,
  onSaved,
  onRefused,
}: {
  readonly area: AreaRow;
  readonly config: Pick<AreaNames, 'defaultLanguage' | 'languages'>;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (area: AreaRow) => void;
  /** The API refused the save: the panel reads the list again. */
  readonly onRefused: () => void;
}) {
  const t = useTranslations('serviceAreas.dialog');
  const errors = useTranslations('serviceAreas.error');
  const { defaultLanguage, languages } = config;
  const [language, setLanguage] = useState(defaultLanguage);
  // The dialog is mounted per opening, so each opening starts from the saved names.
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(languages.map((tag) => [tag, area.names[tag]?.name ?? ''])),
  );
  const [restores, setRestores] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const labels = useDrawerLabels(t('save'));
  const dirty =
    restores.size > 0 ||
    languages.some((tag) => (drafts[tag] ?? '') !== (area.names[tag]?.name ?? ''));

  const current = area.names[language];
  const draft = drafts[language] ?? '';

  function change(value: string) {
    setDrafts((all) => ({ ...all, [language]: value }));
    setRestores((all) => {
      const next = new Set(all);
      next.delete(language);
      return next;
    });
    setError(null);
  }

  function restore() {
    setDrafts((all) => ({ ...all, [language]: current?.configuredName ?? '' }));
    setRestores((all) => new Set(all).add(language));
    setError(null);
  }

  async function submit() {
    if (inFlight.current) return;
    setProblem(null);
    const names: Record<string, string | null> = {};
    for (const tag of languages) {
      const saved = area.names[tag];
      if (restores.has(tag)) {
        names[tag] = null;
        continue;
      }
      const text = (drafts[tag] ?? '').trim();
      if (text === (saved?.name ?? '')) continue;
      if (text === '') {
        setLanguage(tag);
        setError(t('required'));
        return;
      }
      names[tag] = text;
    }
    if (Object.keys(names).length === 0) {
      onClose();
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const result = await callApi<AreaNamesEdited>(
        'POST',
        AREA_NAMES_PATH,
        { areaCode: area.code, names },
        csrfToken,
      );
      if (result.ok) {
        onSaved(result.body.area);
        onClose();
        toast.success(t('saved'));
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setProblem(errors(areaProblemOf(result.failure)));
      onRefused();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <SettingsDrawer
      open
      title={t('title', { code: area.code })}
      onClose={onClose}
      onSubmit={() => void submit()}
      pending={pending}
      dirty={dirty}
      labels={labels}
      notice={problem === null ? undefined : <Banner tone="critical">{problem}</Banner>}
    >
      <Select
        label={t('language')}
        value={language}
        onChange={(event) => {
          setLanguage(event.target.value);
          setError(null);
        }}
        options={languages.map((tag) => ({
          value: tag,
          label:
            tag === defaultLanguage
              ? t('language-required', { name: languageLabel(tag) })
              : languageLabel(tag),
        }))}
      />
      <TextField
        label={t('name')}
        name="name"
        autoComplete="off"
        maxLength={AREA_NAME_MAX}
        value={draft}
        onChange={(event) => change(event.target.value)}
        error={error ?? undefined}
        help={
          current?.configuredName == null
            ? t('help-none')
            : t('help-configured', { name: current.configuredName })
        }
      />
      {current?.edited === true || restores.has(language) ? (
        <div>
          <Button
            variant="secondary"
            className="min-h-12"
            onClick={restore}
            disabled={restores.has(language)}
          >
            {t('restore')}
          </Button>
        </div>
      ) : null}
    </SettingsDrawer>
  );
}
