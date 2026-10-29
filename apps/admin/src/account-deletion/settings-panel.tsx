'use client';

import {
  Banner,
  Button,
  Card,
  LinkButton,
  LoadError,
  RadioGroup,
  Select,
  formatCount,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
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

/**
 * The Market's account deletion setting (customers package 5a): the On/Off choice, the waiting
 * period and the pending requests card. A change asks for a reason in a confirm dialog and then
 * for the two-step code (the shared step-up dialog); the answer drives the screen, nothing is
 * optimistic. A cancelled code leaves the screen as it was, with no message.
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
  const t = useTranslations('account-deletion');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.settings.enabled);
  const [days, setDays] = useState(initial.settings.waitingPeriodDays);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const busy = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const doneNote = useRef<HTMLDivElement>(null);

  const changed = enabled !== saved.settings.enabled || days !== saved.settings.waitingPeriodDays;
  const kind: Kind = enabled !== saved.settings.enabled ? (enabled ? 'on' : 'off') : 'days';
  const off = !canManage || saving;
  const knownPending = pending.state === 'ok' ? pending : null;

  const choices = WAITING_PERIOD_CHOICES.includes(days as (typeof WAITING_PERIOD_CHOICES)[number])
    ? [...WAITING_PERIOD_CHOICES]
    : [...WAITING_PERIOD_CHOICES, days].sort((a, b) => a - b);

  function adopt(answer: AccountDeletionSettingsAnswer) {
    setSaved(answer);
    setEnabled(answer.settings.enabled);
    setDays(answer.settings.waitingPeriodDays);
  }

  async function reload() {
    setReloadFailed(false);
    const result = await callApi<AccountDeletionSettingsAnswer>(
      'GET',
      'customers/admin/account-deletion-settings',
    );
    if (result.ok) {
      adopt(result.body);
      setProblem(null);
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setReloadFailed(true);
  }

  async function save() {
    if (busy.current) return;
    if (reasonProblem(reason)) {
      setReasonError(true);
      return;
    }
    busy.current = true;
    setSaving(true);
    setReasonError(false);
    setProblem(null);
    setDone(false);
    // The confirm closes first, so the code dialog never opens on top of it.
    setConfirming(false);
    const result = await guarded<AccountDeletionSettingsAnswer>(
      'PUT',
      'customers/admin/account-deletion-settings',
      {
        expectedVersion: saved.version,
        settings: { enabled, waitingPeriodDays: days },
        reason: reason.trim(),
      },
      csrfToken,
    );
    busy.current = false;
    setSaving(false);
    if (result.ok) {
      adopt(result.body);
      setReason('');
      setDone(true);
      // The save button is off again (nothing differs): the note takes focus.
      setTimeout(() => doneNote.current?.focus(), 0);
      return;
    }
    if (!isStepUpCancelled(result)) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setProblem(deletionProblemOf(result.failure));
    }
    // The code was cancelled or the call failed: the focus goes back to where the admin was.
    setTimeout(() => saveButton.current?.focus(), 0);
  }

  const title =
    kind === 'on'
      ? t('settings.confirm.on.title')
      : kind === 'off'
        ? t('settings.confirm.off.title')
        : t('settings.confirm.days.title', { days });

  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-4">
      {done ? (
        <div ref={doneNote} tabIndex={-1}>
          <Banner tone="success">{t('settings.saved')}</Banner>
        </div>
      ) : null}
      {problem === null ? null : (
        <Banner tone="critical">
          {t(`error.${problem}`)}
          {problem === 'conflict' ? (
            <>
              {' '}
              <Button variant="secondary" className="mt-2" onClick={() => void reload()}>
                {t('reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      )}
      {reloadFailed ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('settings.load-failed')}
          retryLabel={t('retry')}
          onRetry={() => void reload()}
        />
      ) : null}
      {canManage ? null : <Banner tone="info">{t('settings.read-only')}</Banner>}
      <Card title={t('settings.card')}>
        <RadioGroup
          legend={t('settings.enabled.legend')}
          name="enabled"
          value={enabled ? 'on' : 'off'}
          disabled={off}
          options={[
            { value: 'off', label: t('settings.enabled.off') },
            { value: 'on', label: t('settings.enabled.on') },
          ]}
          note={t('settings.enabled.help')}
          onChange={(value) => {
            setEnabled(value === 'on');
            setDone(false);
          }}
        />
        <Select
          name="waitingPeriodDays"
          label={t('settings.days.label')}
          help={t('settings.days.help')}
          value={String(days)}
          disabled={off}
          options={choices.map((value) => ({
            value: String(value),
            label: t('settings.days.option', { days: value }),
          }))}
          onChange={(event) => {
            setDays(Number(event.target.value));
            setDone(false);
          }}
        />
        {canManage ? (
          <div>
            <Button
              ref={saveButton}
              disabled={!changed}
              loading={saving}
              onClick={() => {
                setReason('');
                setReasonError(false);
                setConfirming(true);
              }}
            >
              {t('settings.save')}
            </Button>
          </div>
        ) : null}
      </Card>
      {pending.state === 'hidden' ? null : (
        <Card title={t('settings.pending.title')}>
          {pending.state === 'unavailable' ? (
            <p>{t('settings.pending.unavailable')}</p>
          ) : pending.count === 0 ? (
            <p>{t('settings.pending.none')}</p>
          ) : pending.more ? (
            <p>{t('settings.pending.more', { count: formatCount(pending.count, true, locale) })}</p>
          ) : (
            <p>{t('settings.pending.some', { count: pending.count })}</p>
          )}
          <div>
            <LinkButton variant="secondary" href={REQUESTS_HREF}>
              {t('settings.pending.view')}
            </LinkButton>
          </div>
        </Card>
      )}
      <ReasonDialog
        open={confirming}
        title={title}
        reasonLabel={t('reason.label')}
        reasonHelp={t('reason.help-history')}
        reason={reason}
        reasonError={reasonError ? t('error.invalid') : undefined}
        onReasonChange={(value) => {
          setReason(value);
          setReasonError(false);
        }}
        confirmLabel={t(`settings.confirm.${kind}.action`)}
        cancelLabel={t('cancel')}
        destructive={kind === 'off'}
        pending={saving}
        onConfirm={() => void save()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          {kind === 'on'
            ? t('settings.confirm.on.body', { days })
            : kind === 'off'
              ? knownPending === null
                ? t('settings.confirm.off.body-unknown')
                : knownPending.more
                  ? t('settings.confirm.off.body-more')
                  : t('settings.confirm.off.body', { count: knownPending.count })
              : t('settings.confirm.days.body')}
        </p>
      </ReasonDialog>
    </div>
  );
}
