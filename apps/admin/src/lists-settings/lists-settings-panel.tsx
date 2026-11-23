'use client';

import {
  Banner,
  SaveBar,
  SettingRow,
  SettingSelect,
  SettingsPage,
  SettingsSection,
  toast,
  useSettingsForm,
  type FieldChange,
  type SaveResult,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { SettingsConflictView } from '../settings/conflict-view.tsx';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { listsProblemOf } from './errors.ts';
import {
  isListPagingValue,
  LIST_PAGING_CODE,
  LIST_PAGING_VALUES,
  listPagingOf,
  type MarketSetting,
  type MarketSettingsAnswer,
} from './types.ts';

interface Draft {
  readonly paging: string;
}

const toDraft = (answer: MarketSettingsAnswer): Draft => ({ paging: listPagingOf(answer).value });
const versionOf = (answer: MarketSettingsAnswer) => listPagingOf(answer).version;

async function reload(): Promise<MarketSettingsAnswer | null> {
  const fresh = await callApi<MarketSettingsAnswer>('GET', 'settings/admin/market-settings');
  return fresh.ok ? fresh.body : null;
}

/**
 * Settings › Lists: how every list of both panels moves between pages (List paging, ADR-0041). The
 * answer drives the screen, nothing is optimistic. A stale version keeps the draft and compares it
 * with what is saved now (the hub's conflict view).
 */
export function ListsSettingsPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: MarketSettingsAnswer;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const P = 'lists-settings';
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const sentForReview = useSentForReview();
  const label = (value: string) => t(`${P}.paging.option.${value}`);
  const form = useSettingsForm<MarketSettingsAnswer, Draft>({
    initial,
    toDraft,
    versionOf,
    reload,
    changes: (saved, draft): readonly FieldChange[] =>
      draft.paging === listPagingOf(saved).value
        ? []
        : [
            {
              key: LIST_PAGING_CODE,
              label: t(`${P}.paging.label`),
              saved: label(listPagingOf(saved).value),
              yours: label(draft.paging),
            },
          ],
  });
  const savedRow = listPagingOf(form.saved);
  const dirty = canManage && form.dirty;
  const count = canManage ? form.count : 0;

  // The note is asked only where the view says a change is reviewed.
  const reviewed = savedRow.review?.reviewed === true;

  function discard() {
    form.discard();
    setProblem(null);
    setNote('');
    setNoteError(null);
  }

  async function save() {
    setProblem(null);
    const sent = reviewed ? trimmedNote(note) : null;
    if (reviewed && sent === null) {
      setNoteError('required');
      return;
    }
    setNoteError(null);
    const result = await form.run(
      async (expectedVersion): Promise<SaveResult<MarketSettingsAnswer>> => {
        const answer = await callApi<MarketSetting & { request?: unknown }>(
          'PUT',
          'settings/admin/market-settings',
          {
            code: LIST_PAGING_CODE,
            value: form.draft.paging,
            expectedVersion,
            ...(sent === null ? {} : { note: sent }),
          },
          csrfToken,
        );
        if (answer.ok) {
          const rest = form.saved.settings.filter((row) => row.code !== LIST_PAGING_CODE);
          const { request, ...row } = answer.body;
          sentForReview({ request });
          return { status: 'saved', saved: { settings: [...rest, row] } };
        }
        if (answer.failure.status === 401) window.location.assign('/session-ended');
        else if (isNoteFailure(answer.failure)) setNoteError('rejected');
        else if (listsProblemOf(answer.failure) === 'conflict') return { status: 'conflict' };
        else setProblem(listsProblemOf(answer.failure));
        return { status: 'failed' };
      },
    );
    if (result.status === 'saved') {
      setNote('');
      toast.success(t(`${P}.saved`));
    } else if (result.status === 'conflict' && result.reloaded === false) setProblem('conflict');
  }

  const banners = [
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t(`${P}.read-only`)}
      </Banner>
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
  const banner =
    banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>;

  return (
    <SettingsPage
      title={t(`${P}.title`)}
      lastChanged={{
        text:
          savedRow.version === 0
            ? t(`${P}.version-defaults`)
            : t(`${P}.version`, { version: savedRow.version }),
      }}
      banner={banner}
      onSubmit={canManage ? () => void save() : undefined}
      dirty={dirty}
      leave={{
        title: t('settings.leave.title'),
        message: t('settings.leave.message'),
        stay: t('settings.leave.stay'),
        leave: t('settings.leave.leave'),
      }}
      saveBar={
        canManage ? (
          <SaveBar
            count={count}
            summary={t('settings.bar.summary', { count })}
            errorCount={0}
            errorsSummary={t('settings.bar.errors', { count: 0 })}
            saving={form.saving}
            labels={{
              region: t('settings.bar.region'),
              discard: t('settings.bar.discard'),
              save: t('settings.bar.save'),
              saving: t('settings.bar.saving'),
            }}
            onDiscard={discard}
          />
        ) : null
      }
    >
      <SettingsSection title={t(`${P}.section`)}>
        <SettingRow
          settingId="list-paging"
          label={t(`${P}.paging.label`)}
          help={t(`${P}.paging.help`)}
          changed={form.draft.paging !== savedRow.value}
          disabled={!canManage}
        >
          <SettingSelect
            name="listPaging"
            value={form.draft.paging}
            options={LIST_PAGING_VALUES.map((value) => ({ value, label: label(value) }))}
            onChange={(event) => {
              const value = event.target.value;
              if (isListPagingValue(value)) form.setDraft({ paging: value });
            }}
          />
        </SettingRow>
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
