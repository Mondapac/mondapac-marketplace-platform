'use client';

import {
  Banner,
  SaveBar,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingsErrorSummary,
  SettingsPage,
  SettingsSection,
  toast,
  useLiveErrors,
  useSettingsForm,
  type FieldChange,
  type SaveResult,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { SettingsConflictView } from '../settings/conflict-view.tsx';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { offerReviewProblemOf } from './errors.ts';
import {
  BADGES_CODE,
  BADGES_VALUES,
  BAND_CODE,
  MODE_CODE,
  MODE_VALUES,
  NUMBER_BOUNDS,
  NUMBER_CODES,
  numberValueOf,
  OFFER_REVIEW_PATH,
  offerReviewAnswerOf,
  PROBATION_CODE,
  REFERENCE_CODE,
  SAMPLING_CODE,
  settingOf,
  type NumberCode,
  type OfferReviewAnswer,
  type OfferReviewSetting,
} from './types.ts';

const P = 'offer-review-settings';
const CODES = [
  MODE_CODE,
  BADGES_CODE,
  PROBATION_CODE,
  REFERENCE_CODE,
  BAND_CODE,
  SAMPLING_CODE,
] as const;
type Code = (typeof CODES)[number];
type Draft = Readonly<Record<Code, string>>;

const toDraft = (answer: OfferReviewAnswer): Draft =>
  Object.fromEntries(CODES.map((code) => [code, settingOf(answer, code).value])) as Draft;
/** Changes with each setting's own version; the sum only tells the form that one moved. */
const versionOf = (answer: OfferReviewAnswer) =>
  CODES.reduce((sum, code) => sum + settingOf(answer, code).version, 0);

async function reload(): Promise<OfferReviewAnswer | null> {
  const fresh = await callApi<unknown>('GET', OFFER_REVIEW_PATH);
  return fresh.ok ? offerReviewAnswerOf(fresh.body) : null;
}

const isNumberCode = (code: Code): code is NumberCode =>
  (NUMBER_CODES as readonly string[]).includes(code);

/** The draft's value as the API takes it (a number trimmed), or null when it is not allowed. */
const sentValue = (code: Code, typed: string): string | null =>
  isNumberCode(code) ? numberValueOf(code, typed) : typed;

/**
 * Settings › Catalogue › Offer review: how a new Offer on a platform product is approved in the
 * Market (risk-based Offer approval) and the numbers its rules use. One save writes every changed
 * setting with the version the admin saw, all or nothing; the answer drives the screen. A stale
 * version keeps the draft and compares it with what is saved now.
 */
export function OfferReviewPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: OfferReviewAnswer;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const chrome = useSettingsChrome();
  // The manage key is protected, so a save may ask for a fresh two-step code first.
  const guarded = useGuardedCall();
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const sentForReview = useSentForReview();

  const shown = (code: Code, value: string) =>
    code === MODE_CODE || code === BADGES_CODE
      ? t(`${P}.${code}.option.${value}`)
      : code === BAND_CODE || code === SAMPLING_CODE
        ? `${value}%`
        : value;

  const form = useSettingsForm<OfferReviewAnswer, Draft>({
    initial,
    toDraft,
    versionOf,
    reload,
    changes: (saved, draft): readonly FieldChange[] =>
      CODES.filter((code) => draft[code].trim() !== settingOf(saved, code).value).map((code) => ({
        key: code,
        label: t(`${P}.${code}.label`),
        saved: shown(code, settingOf(saved, code).value),
        yours: shown(code, draft[code].trim()),
      })),
  });
  // After a conflict the versions to send are those saved now.
  const baseline = form.theirs ?? form.saved;
  const failing = NUMBER_CODES.filter(
    (code) =>
      form.draft[code].trim() !== settingOf(baseline, code).value &&
      numberValueOf(code, form.draft[code]) === null,
  );
  const live = useLiveErrors<NumberCode>(failing);
  const count = canManage ? form.count : 0;
  const reviewed = CODES.some((code) => settingOf(form.saved, code).review?.reviewed === true);

  const setValue = (code: Code, value: string) =>
    form.setDraft((current) => ({ ...current, [code]: value }));

  function discard() {
    form.discard();
    live.reset();
    setProblem(null);
    setNote('');
    setNoteError(null);
  }

  async function save() {
    setProblem(null);
    if (failing.length > 0) {
      live.attempt();
      return;
    }
    const sent = reviewed ? trimmedNote(note) : null;
    if (reviewed && sent === null) {
      setNoteError('required');
      return;
    }
    setNoteError(null);
    const result = await form.run(async (): Promise<SaveResult<OfferReviewAnswer>> => {
      const latest = form.theirs ?? form.saved;
      const changes = CODES.flatMap((code) => {
        const value = sentValue(code, form.draft[code]);
        const row = settingOf(latest, code);
        return value === null || value === row.value
          ? []
          : [{ code, value, expectedVersion: row.version }];
      });
      const answer = await guarded<{
        settings: readonly (OfferReviewSetting & { request?: unknown })[];
      }>(
        'PUT',
        OFFER_REVIEW_PATH,
        { changes, ...(sent === null ? {} : { note: sent }) },
        csrfToken,
      );
      if (answer.ok) {
        const changed = answer.body.settings.map(({ request, ...row }) => {
          sentForReview({ request });
          return row;
        });
        const codes = new Set(changed.map((row) => row.code));
        const rest = latest.settings.filter((row) => !codes.has(row.code));
        return { status: 'saved', saved: { settings: [...rest, ...changed] } };
      }
      if (isStepUpCancelled(answer)) return { status: 'failed' };
      if (answer.failure.status === 401) window.location.assign('/session-ended');
      else if (isNoteFailure(answer.failure)) setNoteError('rejected');
      else if (offerReviewProblemOf(answer.failure) === 'conflict') return { status: 'conflict' };
      else setProblem(offerReviewProblemOf(answer.failure));
      return { status: 'failed' };
    });
    if (result.status === 'saved') {
      setNote('');
      live.reset();
      toast.success(t(`${P}.saved`));
    } else if (result.status === 'conflict' && result.reloaded === false) setProblem('conflict');
  }

  const errorOf = (code: NumberCode) =>
    live.has(code) ? t(`${P}.invalid-number`, NUMBER_BOUNDS[code]) : undefined;

  const banners = [
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t(`${P}.read-only`)}
      </Banner>
    ),
    live.shown.length === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: live.shown.length })}
        items={live.shown.map((code) => ({
          id: `setting-${code}`,
          label: t(`${P}.${code}.label`),
          reason: errorOf(code),
        }))}
        focusSignal={live.attempts}
      />
    ),
    form.theirs === null ? null : (
      <SettingsConflictView key="conflict" conflictId={form.conflictId} changes={form.changes} />
    ),
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`${P}.error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  const choiceRow = (code: typeof MODE_CODE | typeof BADGES_CODE, values: readonly string[]) => (
    <SettingRow
      settingId={code}
      label={t(`${P}.${code}.label`)}
      help={t(`${P}.${code}.help`)}
      changed={form.draft[code] !== settingOf(form.saved, code).value}
      disabled={!canManage}
    >
      <SettingSelect
        name={code}
        value={form.draft[code]}
        options={values.map((value) => ({ value, label: t(`${P}.${code}.option.${value}`) }))}
        onChange={(event) => {
          const value = event.target.value;
          if (values.includes(value)) setValue(code, value);
        }}
      />
    </SettingRow>
  );

  const numberRow = (code: NumberCode) => (
    <SettingRow
      id={`setting-${code}`}
      settingId={code}
      label={t(`${P}.${code}.label`)}
      help={t(`${P}.${code}.help`, NUMBER_BOUNDS[code])}
      error={errorOf(code)}
      changed={form.draft[code].trim() !== settingOf(form.saved, code).value}
      disabled={!canManage}
    >
      <SettingInput
        name={code}
        inputMode="numeric"
        dir="ltr"
        autoComplete="off"
        value={form.draft[code]}
        onChange={(event) => setValue(code, event.target.value)}
        onBlur={() => live.touch(code)}
      />
    </SettingRow>
  );

  const lastVersion = Math.max(...CODES.map((code) => settingOf(form.saved, code).version));

  return (
    <SettingsPage
      title={t(`${P}.title`)}
      lastChanged={{
        text: lastVersion === 0 ? t(`${P}.version-defaults`) : t(`${P}.changed-before`),
      }}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={canManage ? () => void save() : undefined}
      dirty={canManage && form.dirty}
      dirtyCount={count}
      leave={chrome.leave}
      saveBar={
        canManage ? (
          <SaveBar
            {...chrome.saveBar({
              count,
              errorCount: live.shown.length,
              saving: form.saving,
              onDiscard: discard,
            })}
          />
        ) : null
      }
    >
      <SettingsSection title={t(`${P}.section.approval`)} description={t(`${P}.intro`)}>
        {choiceRow(MODE_CODE, MODE_VALUES)}
        {choiceRow(BADGES_CODE, BADGES_VALUES)}
      </SettingsSection>
      <SettingsSection title={t(`${P}.section.sellers`)}>
        {numberRow(PROBATION_CODE)}
      </SettingsSection>
      <SettingsSection title={t(`${P}.section.prices`)}>
        {numberRow(REFERENCE_CODE)}
        {numberRow(BAND_CODE)}
      </SettingsSection>
      <SettingsSection title={t(`${P}.section.sampling`)}>
        {numberRow(SAMPLING_CODE)}
      </SettingsSection>
      {reviewed && canManage ? (
        <SettingsSection title={t(`${P}.review-section`)}>
          <div className="px-5 py-4">
            <ReviewNoteField
              value={note}
              onChange={(next) => {
                setNote(next);
                setNoteError(null);
              }}
              error={noteError ?? undefined}
            />
          </div>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
