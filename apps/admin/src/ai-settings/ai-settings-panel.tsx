'use client';

import {
  Badge,
  Banner,
  SettingRow,
  SettingSelect,
  SettingsPage,
  SettingsSection,
  Switch,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { aiProblemOf } from './errors.ts';
import {
  AI_SETTINGS_PATH,
  TIER_CODE,
  TIER_VALUES,
  WRITER_CODE,
  isTierValue,
  settingOf,
  settingsAnswerOf,
  type AiSetting,
  type AiSettingsAnswer,
  type ModelSetup,
} from './types.ts';

/**
 * Settings › AI: the Market switch of "Write with AI (product descriptions)" and its model tier,
 * with a read-only view of what the server is configured with. Each control saves at once, with
 * the version the admin saw; the answer drives the screen (nothing is optimistic). Changing needs
 * the protected `settings.ai.manage`, so it may ask for a fresh two-step code. A stale version
 * loads what is saved now and says so. The key is never shown, only whether one is set.
 */
export function AiSettingsPanel({
  initial,
  setup,
  canManage,
  csrfToken,
}: {
  readonly initial: AiSettingsAnswer;
  /** Null when the model setup could not be read; the card then says so. */
  readonly setup: ModelSetup | null;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('ai-settings');
  const root = useTranslations();
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [saved, setSaved] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const sentForReview = useSentForReview();
  const busy = useRef(false);

  const writer = settingOf(saved, WRITER_CODE);
  const tier = settingOf(saved, TIER_CODE);
  const on = writer.value === 'on';

  const replace = (row: AiSetting) =>
    setSaved((current) => ({
      settings: [...current.settings.filter((item) => item.code !== row.code), row],
    }));

  async function change(row: AiSetting, value: string) {
    if (busy.current || row.value === value) return;
    // Where the view says a change is reviewed, it goes with the note for the reviewers.
    const sent = row.review?.reviewed === true ? trimmedNote(note) : null;
    if (row.review?.reviewed === true && sent === null) {
      setNoteError('required');
      return;
    }
    setNoteError(null);
    busy.current = true;
    setPending(row.code);
    setProblem(null);
    const result = await guarded<AiSetting & { request?: unknown }>(
      'PUT',
      AI_SETTINGS_PATH,
      {
        code: row.code,
        value,
        expectedVersion: row.version,
        ...(sent === null ? {} : { note: sent }),
      },
      csrfToken,
    );
    if (result.ok) {
      const { request, ...changed } = result.body;
      replace(changed);
      setNote('');
      busy.current = false;
      setPending(null);
      toast.success(t('saved'));
      sentForReview({ request });
      return;
    }
    if (!isStepUpCancelled(result)) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
      } else if (isNoteFailure(result.failure)) {
        setNoteError('rejected');
      } else {
        const key = aiProblemOf(result.failure);
        setProblem(key);
        if (key === 'conflict') {
          // Someone saved first: show what is saved now, keep nothing of the stale choice.
          const fresh = await callApi<unknown>('GET', AI_SETTINGS_PATH);
          if (!fresh.ok && fresh.failure.status === 401) {
            window.location.assign('/session-ended');
            busy.current = false;
            setPending(null);
            return;
          }
          const answer = fresh.ok ? settingsAnswerOf(fresh.body) : null;
          if (answer !== null) setSaved(answer);
        }
      }
    }
    busy.current = false;
    setPending(null);
  }

  const when = (row: AiSetting) =>
    row.updatedAt === null
      ? t('never-changed')
      : t('last-changed', { when: formatInstant(row.updatedAt, locale) });

  const banners = [
    setup?.killSwitch === true ? (
      <Banner key="kill" tone="attention" title={t('kill-title')}>
        <p>{t('kill-body')}</p>
      </Banner>
    ) : null,
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t('read-only')}
      </Banner>
    ),
    problem === null ? null : (
      // A conflict is not a failure: it is announced politely (status), not as an alert.
      <Banner key="problem" tone={problem === 'conflict' ? 'attention' : 'critical'}>
        {t(`error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  const asksNote =
    canManage && (writer.review?.reviewed === true || tier.review?.reviewed === true);

  const modelLine = (id: string | null) => (id === null ? t('model-none') : id);

  return (
    <SettingsPage
      title={t('title')}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
    >
      {asksNote ? (
        <SettingsSection title={t('section-review')} description={t('review-intro')}>
          <div className="px-5 py-4">
            <ReviewNoteField
              value={note}
              onChange={(next) => {
                setNote(next);
                setNoteError(null);
              }}
              error={noteError ?? undefined}
              disabled={pending !== null}
            />
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t('section-writer')}>
        <SettingRow
          id="ai-writer"
          settingId="ai-description-writer"
          label={t('switch.label')}
          help={`${t('switch.help')} ${when(writer)}`}
          plain
        >
          <div className="flex items-center gap-3">
            <Switch
              aria-labelledby="ai-writer-label"
              checked={on}
              disabled={!canManage || pending !== null}
              onCheckedChange={(next) => void change(writer, next ? 'on' : 'off')}
            />
            <span aria-live="polite">{on ? t('switch.on') : t('switch.off')}</span>
          </div>
        </SettingRow>
        <SettingRow
          settingId="ai-description-writer-tier"
          label={t('tier.label')}
          help={`${t('tier.help')} ${when(tier)}`}
          disabled={!canManage || pending !== null}
        >
          <SettingSelect
            name="tier"
            value={tier.value}
            options={TIER_VALUES.map((value) => ({ value, label: t(`tier.option.${value}`) }))}
            onChange={(event) => {
              const value = event.target.value;
              if (isTierValue(value)) void change(tier, value);
            }}
          />
        </SettingRow>
        {canManage ? (
          <p className="px-5 py-3 text-sm text-fg-muted">{root('step-up.wait-note')}</p>
        ) : null}
      </SettingsSection>
      <SettingsSection title={t('section-setup')} description={t('setup-intro')}>
        {setup === null ? (
          <div className="px-5 py-4">
            <Banner tone="info">{t('setup-unavailable')}</Banner>
          </div>
        ) : (
          <>
            <SettingRow label={t('model.fast')} plain>
              <p>{modelLine(setup.models.fast)}</p>
            </SettingRow>
            <SettingRow label={t('model.balanced')} plain>
              <p>{modelLine(setup.models.balanced)}</p>
            </SettingRow>
            <SettingRow label={t('key.label')} help={t('key.help')} plain>
              <Badge tone={setup.keyConfigured ? 'success' : 'attention'}>
                {setup.keyConfigured ? t('key.set') : t('key.missing')}
              </Badge>
            </SettingRow>
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
