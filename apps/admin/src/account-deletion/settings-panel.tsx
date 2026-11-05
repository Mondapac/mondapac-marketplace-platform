'use client';

import {
  Banner,
  LinkButton,
  SaveBar,
  SettingCheckbox,
  SettingRow,
  SettingSelect,
  SettingsPage,
  SettingsSection,
  formatCount,
  toast,
  useSettingsForm,
  type FieldChange,
  type SaveResult,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { SettingsConflictView } from '../settings/conflict-view.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { deletionProblemOf } from './errors.ts';
import { ReasonDialog } from './reason-dialog.tsx';
import {
  reasonProblem,
  REQUESTS_HREF,
  WAITING_PERIOD_CHOICES,
  type AccountDeletionSettingsAnswer,
  type PendingCount,
} from './types.ts';

type Kind = 'on' | 'off' | 'days';

interface Draft {
  readonly enabled: boolean;
  readonly days: number;
}

const toDraft = (answer: AccountDeletionSettingsAnswer): Draft => ({
  enabled: answer.settings.enabled,
  days: answer.settings.waitingPeriodDays,
});
const versionOf = (answer: AccountDeletionSettingsAnswer) => answer.version;
async function reload(): Promise<AccountDeletionSettingsAnswer | null> {
  const fresh = await callApi<AccountDeletionSettingsAnswer>(
    'GET',
    'customers/admin/account-deletion-settings',
  );
  return fresh.ok ? fresh.body : null;
}

/**
 * The Market's account deletion setting (customers package 5a) on the settings template: the On/Off
 * switch, the waiting period and the pending requests card. Save opens a confirm dialog with a
 * required reason, then the two-step code (the shared step-up dialog). The answer drives the
 * screen, nothing is optimistic. A cancelled code leaves the draft as it was, with no message; a
 * stale version keeps the draft and compares it with what is saved now (the hub's conflict view).
 */
export function AccountDeletionSettingsPanel({
  initial,
  canManage,
  pending,
  csrfToken,
}: {
  readonly initial: AccountDeletionSettingsAnswer;
  readonly canManage: boolean;
  readonly pending: PendingCount;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const P = 'account-deletion';
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const day = (days: number) => t(`${P}.settings.days.option`, { days });
  const onOff = (enabled: boolean) => t(`${P}.settings.enabled.${enabled ? 'on' : 'off'}`);
  const form = useSettingsForm<AccountDeletionSettingsAnswer, Draft>({
    initial,
    toDraft,
    versionOf,
    reload,
    changes: (saved, draft): readonly FieldChange[] => [
      ...(draft.enabled === saved.settings.enabled
        ? []
        : [
            {
              key: 'enabled',
              label: t(`${P}.settings.enabled.legend`),
              saved: onOff(saved.settings.enabled),
              yours: onOff(draft.enabled),
            },
          ]),
      ...(draft.days === saved.settings.waitingPeriodDays
        ? []
        : [
            {
              key: 'days',
              label: t(`${P}.settings.days.label`),
              saved: day(saved.settings.waitingPeriodDays),
              yours: day(draft.days),
            },
          ]),
    ],
  });
  const { enabled, days } = form.draft;
  const savedSettings = form.saved.settings;
  const kind: Kind = enabled !== savedSettings.enabled ? (enabled ? 'on' : 'off') : 'days';
  const dirty = canManage && form.dirty;
  const count = canManage ? form.count : 0;
  const knownPending = pending.state === 'ok' ? pending : null;
  const pendingText =
    pending.state === 'hidden'
      ? ''
      : pending.state === 'unavailable'
        ? t(`${P}.settings.pending.unavailable`)
        : pending.count === 0
          ? t(`${P}.settings.pending.none`)
          : pending.more
            ? t(`${P}.settings.pending.more`, { count: formatCount(pending.count, true, locale) })
            : t(`${P}.settings.pending.some`, { count: pending.count });

  const choices = WAITING_PERIOD_CHOICES.includes(days as (typeof WAITING_PERIOD_CHOICES)[number])
    ? [...WAITING_PERIOD_CHOICES]
    : [...WAITING_PERIOD_CHOICES, days].sort((a, b) => a - b);
  if (!choices.includes(savedSettings.waitingPeriodDays)) {
    choices.push(savedSettings.waitingPeriodDays);
    choices.sort((a, b) => a - b);
  }

  function discard() {
    form.discard();
    setProblem(null);
  }

  function review() {
    setProblem(null);
    setReason('');
    setReasonError(false);
    setConfirming(true);
  }

  async function save() {
    if (reasonProblem(reason)) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    setProblem(null);
    // The confirm closes first, so the code dialog never opens on top of it.
    setConfirming(false);
    const result = await form.run(
      async (expectedVersion): Promise<SaveResult<AccountDeletionSettingsAnswer>> => {
        const answer = await guarded<AccountDeletionSettingsAnswer>(
          'PUT',
          'customers/admin/account-deletion-settings',
          {
            expectedVersion,
            settings: { enabled, waitingPeriodDays: days },
            reason: reason.trim(),
          },
          csrfToken,
        );
        if (answer.ok) return { status: 'saved', saved: answer.body };
        // A cancelled code leaves the screen as it was, with no message.
        if (isStepUpCancelled(answer)) return { status: 'failed' };
        if (answer.failure.status === 401) window.location.assign('/session-ended');
        else if (deletionProblemOf(answer.failure) === 'conflict') return { status: 'conflict' };
        else setProblem(deletionProblemOf(answer.failure));
        return { status: 'failed' };
      },
    );
    if (result.status === 'saved') {
      setReason('');
      toast.success(t(`${P}.settings.saved`));
    }
    // The re-read failed too: the plain "reload the page" message is all that is left.
    else if (result.status === 'conflict' && result.reloaded === false) setProblem('conflict');
  }

  const banners = [
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t(`${P}.settings.read-only`)}
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

  const title =
    kind === 'on'
      ? t(`${P}.settings.confirm.on.title`)
      : kind === 'off'
        ? t(`${P}.settings.confirm.off.title`)
        : t(`${P}.settings.confirm.days.title`, { days });

  return (
    <SettingsPage
      title={t(`${P}.settings.card`)}
      description={t(`${P}.settings.intro`)}
      lastChanged={{
        text:
          form.saved.version === 0
            ? t(`${P}.settings.version-defaults`)
            : t(`${P}.settings.version`, { version: form.saved.version }),
      }}
      banner={banner}
      onSubmit={canManage ? review : undefined}
      dirty={dirty}
      dirtyCount={count}
      leave={{
        title: t('settings.leave.title'),
        message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
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
      <SettingsSection title={t(`${P}.settings.section`)}>
        <SettingRow
          settingId="account-deletion-enabled"
          label={t(`${P}.settings.enabled.legend`)}
          help={t(`${P}.settings.enabled.help`)}
          changed={enabled !== savedSettings.enabled}
          disabled={!canManage}
        >
          <SettingCheckbox
            name="enabled"
            text={onOff(enabled)}
            checked={enabled}
            onChange={(event) =>
              form.setDraft((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
        </SettingRow>
        <SettingRow
          settingId="account-deletion-days"
          label={t(`${P}.settings.days.label`)}
          help={t(`${P}.settings.days.help`)}
          changed={days !== savedSettings.waitingPeriodDays}
          disabled={!canManage}
        >
          <SettingSelect
            name="waitingPeriodDays"
            value={String(days)}
            options={choices.map((value) => ({ value: String(value), label: day(value) }))}
            onChange={(event) =>
              form.setDraft((current) => ({ ...current, days: Number(event.target.value) }))
            }
          />
        </SettingRow>
      </SettingsSection>
      {pending.state === 'hidden' ? null : (
        <SettingsSection title={t(`${P}.settings.pending.title`)}>
          <SettingRow label={pendingText} plain>
            <LinkButton variant="secondary" href={REQUESTS_HREF}>
              {t(`${P}.settings.pending.view`)}
            </LinkButton>
          </SettingRow>
        </SettingsSection>
      )}
      <ReasonDialog
        open={confirming}
        title={title}
        reasonLabel={t(`${P}.reason.label`)}
        reasonHelp={t(`${P}.reason.help-history`)}
        reason={reason}
        reasonError={reasonError ? t(`${P}.error.invalid`) : undefined}
        onReasonChange={(value) => {
          setReason(value);
          setReasonError(false);
        }}
        confirmLabel={t(`${P}.settings.confirm.${kind}.action`)}
        cancelLabel={t(`${P}.cancel`)}
        destructive={kind === 'off'}
        pending={form.saving}
        onConfirm={() => void save()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          {kind === 'on'
            ? t(`${P}.settings.confirm.on.body`, { days })
            : kind === 'off'
              ? knownPending === null
                ? t(`${P}.settings.confirm.off.body-unknown`)
                : knownPending.more
                  ? t(`${P}.settings.confirm.off.body-more`)
                  : t(`${P}.settings.confirm.off.body`, { count: knownPending.count })
              : t(`${P}.settings.confirm.days.body`)}
        </p>
      </ReasonDialog>
    </SettingsPage>
  );
}
