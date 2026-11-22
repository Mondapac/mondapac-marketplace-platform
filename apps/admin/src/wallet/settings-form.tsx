'use client';

import {
  Badge,
  Banner,
  SettingsViewOnlyBanner,
  Button,
  DataList,
  Dialog,
  LoadError,
  SaveBar,
  SettingRow,
  SettingSelect,
  SettingsConflictBanner,
  SettingsPage,
  SettingsSection,
  SettingsSkeleton,
  toast,
  type BadgeTone,
  useDelayedLoading,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { useChangeHistory, useWinnerTitle } from '../settings/last-changed.tsx';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import { formatInstant } from '../shared/format.ts';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { walletProblemOf } from './errors.ts';
import { wordFor } from './labels.ts';
import {
  REASON_STATES,
  STATUS_REASONS,
  WALLET_STATES,
  type WalletSettings,
  type WalletState,
} from './types.ts';

const TONE: Readonly<Record<WalletState, BadgeTone>> = {
  active: 'success',
  paused: 'attention',
  frozen: 'critical',
  off: 'neutral',
};

/**
 * The wallet switch of the Market: current state, a change form and what each state means. The
 * response drives the screen; no optimistic update. Every change goes through the step-up dialog.
 */
export function SettingsForm({
  canManage,
  csrfToken,
}: {
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('wallet');
  const root = useTranslations();
  const locale = useLocale();
  const guarded = useGuardedCall();
  const chrome = useSettingsChrome();
  const [settings, setSettings] = useState<WalletSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<WalletState | ''>('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const sentForReview = useSentForReview();
  const [conflict, setConflict] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The field a refused Review points at; a new object each time, so a second refusal moves focus again.
  const [focusField, setFocusField] = useState<{ readonly name: string } | null>(null);
  const busy = useRef(false);
  // Before the loading and error returns below: a hook is called on every render.
  const changeHistory = useChangeHistory(settings?.lastChanged, 'wallet/admin/settings/history');
  const winnerTitle = useWinnerTitle();
  // Shown after 200 ms, held at least 400 ms; at 30 s the load counts as failed.
  const loading = useDelayedLoading(settings === null && !loadFailed);

  // Each read gets a number; an answer to an older read (one abandoned at the 30 s stall, or
  // replaced by Try again) is dropped, so it never overwrites what the newer read showed.
  const attempt = useRef(0);
  const load = useCallback(async () => {
    const mine = ++attempt.current;
    setLoadFailed(false);
    const result = await callApi<WalletSettings>('GET', 'wallet/admin/settings');
    if (mine !== attempt.current) return;
    if (result.ok) {
      // A state the panel does not know is not shown as a guess.
      if (WALLET_STATES.includes(result.body.status) && Number.isInteger(result.body.version)) {
        setSettings(result.body);
      } else setLoadFailed(true);
    } else if (result.failure.status === 401) {
      flushSync(() => setLeaving(true));
      window.location.assign('/session-ended');
    } else setLoadFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // After the refused field renders its error: Review is then off, so focus goes to what to fix.
  useEffect(() => {
    if (focusField === null) return;
    document.querySelector<HTMLElement>(`[name="${focusField.name}"]`)?.focus();
  }, [focusField]);

  useEffect(() => {
    if (!loading.stalled) return;
    attempt.current += 1;
    setLoadFailed(true);
  }, [loading.stalled]);

  const title = t('settings.title');
  const intro = t('settings.intro');
  if (loadFailed) {
    return (
      <SettingsPage title={title} description={intro}>
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-failed')}
          retryLabel={t('retry')}
          onRetry={() => void load()}
        />
      </SettingsPage>
    );
  }
  if (settings === null || loading.visible) {
    return (
      <SettingsPage title={title} description={intro}>
        <SettingsSkeleton
          label={root('route.loading-page', { page: title })}
          header={false}
          sections={[
            { fields: 2 },
            { fields: WALLET_STATES.length },
            { fields: 2, description: true },
          ]}
          visible={loading.visible}
          slow={loading.slow}
          slowLabel={root('route.slow')}
        />
      </SettingsPage>
    );
  }

  const current = settings.status;
  const loadedVersion = settings.version;
  const chosen: WalletState = state === '' ? current : state;
  const needsReason = REASON_STATES.includes(chosen);
  const unchanged = chosen === current;
  const incomplete = needsReason && reason === '';
  // Area money is reviewed: every change needs a note, except a stop (paused, frozen), which
  // opens no review.
  const needsNote = chosen !== 'paused' && chosen !== 'frozen';
  const reasonLabel = (code: string | null) => (code === null ? null : wordFor(t, 'reason', code));

  async function send() {
    if (busy.current) return;
    const sent = needsNote ? trimmedNote(note) : null;
    if (needsNote && sent === null) {
      setConfirming(false);
      setNoteError('required');
      return;
    }
    setNoteError(null);
    busy.current = true;
    setPending(true);
    // The confirm closes; the code dialog opens on its own (no stack of two dialogs).
    setConfirming(false);
    setProblem(null);
    setReasonError(false);
    setConflict(false);
    const before = current;
    const result = await guarded<WalletSettings>(
      'PUT',
      'wallet/admin/settings',
      {
        status: chosen,
        ...(needsReason ? { reasonCode: reason } : {}),
        expectedVersion: loadedVersion,
        ...(sent === null ? {} : { note: sent }),
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    setConfirming(false);
    if (result.ok) {
      setSettings(result.body);
      setState('');
      setReason('');
      setNote('');
      const kind = before === chosen ? 'already' : 'changed';
      const text = t(`settings.notice.${kind}`, {
        state: t(`state.${result.body.status}`).toLowerCase(),
      });
      if (kind === 'changed') toast.success(text);
      else toast.info(text);
      sentForReview(result.body);
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      // The leave prompt is dropped first, so the browser does not ask on the way out.
      flushSync(() => setLeaving(true));
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.code === 'wallet.settings-conflict') {
      // Someone saved first: show the current state, keep the state and reason the admin chose.
      setConflict(true);
      await load();
      return;
    }
    if (isNoteFailure(result.failure)) {
      setNoteError('rejected');
      return;
    }
    const key = walletProblemOf(result.failure, 'settings');
    if (key === 'validation-settings') setReasonError(true);
    else setProblem(key);
  }

  function review() {
    if (busy.current || unchanged) return;
    setProblem(null);
    // A missing reason or note is shown on its field, which takes focus; Review stays off until it is fixed.
    if (incomplete) {
      setReasonError(true);
      setFocusField({ name: 'reasonCode' });
      return;
    }
    if (needsNote && trimmedNote(note) === null) {
      setNoteError('required');
      setFocusField({ name: 'note' });
      return;
    }
    if (chosen === 'active') void send();
    else setConfirming(true);
  }

  function discard() {
    setState('');
    setReason('');
    setNote('');
    setReasonError(false);
    setNoteError(null);
    setProblem(null);
  }

  // The confirm dialog exists for off, paused and frozen; Active applies after the code only.
  const confirmKey = chosen === 'active' ? null : chosen;
  const stateOptions = WALLET_STATES.map((value) => ({
    value,
    label:
      value === current ? `${t(`state.${value}`)} ${t('current-marker')}` : t(`state.${value}`),
  }));

  const banners = [
    conflict ? (
      <SettingsConflictBanner
        key="conflict"
        title={winnerTitle(settings.lastChanged) ?? t('settings.conflict-title')}
        body={t('settings.conflict-body')}
      />
    ) : null,
    canManage ? null : (
      <SettingsViewOnlyBanner key="view-only" title={root('settings.view-only.title')}>
        {root('settings.view-only.body')}
      </SettingsViewOnlyBanner>
    ),
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={title}
      description={intro}
      lastChanged={changeHistory.line}
      overlay={changeHistory.drawer}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={canManage ? review : undefined}
      dirty={canManage && !unchanged && !leaving}
      dirtyCount={unchanged ? 0 : 1}
      leave={chrome.leave}
      saveBar={
        canManage ? (
          <SaveBar
            {...chrome.saveBar({
              count: unchanged ? 0 : 1,
              // Only what the admin still has to fill in blocks Review; after a refusal from the
              // server the same values can be sent again.
              errorCount:
                (reasonError && reason === '' ? 1 : 0) + (noteError === 'required' ? 1 : 0),
              saving: pending,
              onDiscard: discard,
              saveLabel: t('settings.review'),
            })}
          />
        ) : undefined
      }
    >
      <SettingsSection title={t('settings.current')}>
        <SettingRow label={t('settings.state')} plain>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={TONE[current]}>{t(`state.${current}`)}</Badge>
            <span>{t(`meaning.short.${current}`)}</span>
          </div>
        </SettingRow>
        <SettingRow label={t('settings.last-change')} plain>
          <p className="text-fg-muted">
            {settings.updatedAt === null
              ? t('settings.never-changed')
              : t('settings.changed', { when: formatInstant(settings.updatedAt, locale) })}
          </p>
          {(current === 'paused' || current === 'frozen') &&
          reasonLabel(settings.reason) !== null ? (
            <p className="mt-1 text-fg-muted">
              {t('settings.reason-line', { reason: reasonLabel(settings.reason) ?? '' })}
            </p>
          ) : null}
        </SettingRow>
      </SettingsSection>
      <SettingsSection title={t('settings.meanings')}>
        <div className="px-5 py-4">
          <DataList
            missing=""
            rows={WALLET_STATES.map((value) => ({
              label: t(`state.${value}`),
              value: t(`meaning.${value}`),
            }))}
          />
        </div>
      </SettingsSection>
      {/* Changing the state is the page's one change: the save bar's "Review change" opens its
          confirmation (and then the code), so it stays in the danger zone without a button. */}
      <SettingsSection
        variant="danger"
        title={root('settings.danger.title')}
        description={t('settings.danger.description')}
      >
        <SettingRow
          label={t('settings.new-state')}
          help={
            canManage && unchanged
              ? `${t(`meaning.${chosen}`)} ${t('settings.choose-first')}`
              : t(`meaning.${chosen}`)
          }
          changed={!unchanged}
          disabled={!canManage}
        >
          <SettingSelect
            name="status"
            value={chosen}
            options={stateOptions}
            onChange={(event) => {
              setState(event.target.value as WalletState);
              setReason('');
              setReasonError(false);
              setNoteError(null);
            }}
          />
        </SettingRow>
        {needsReason ? (
          <SettingRow
            label={t('settings.reason')}
            disabled={!canManage}
            error={reasonError ? t('error.validation-settings') : undefined}
          >
            <SettingSelect
              name="reasonCode"
              placeholder={t('settings.reason-placeholder')}
              value={reason}
              options={STATUS_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) }))}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(false);
              }}
            />
          </SettingRow>
        ) : null}
        {canManage && needsNote ? (
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
        ) : null}
        {canManage ? (
          <p className="px-5 py-4 text-sm text-fg-muted">{root('step-up.wait-note')}</p>
        ) : null}
      </SettingsSection>
      <Dialog
        open={confirming}
        title={confirmKey === null ? '' : t(`settings.confirm.${confirmKey}.title`)}
        onClose={() => {
          if (!pending) setConfirming(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              autoFocus
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant={chosen === 'off' ? 'destructive' : 'primary'}
              loading={pending}
              onClick={() => void send()}
            >
              {confirmKey === null ? '' : t(`settings.confirm.${confirmKey}.action`)}
            </Button>
          </>
        }
      >
        <p>{confirmKey === null ? '' : t(`settings.confirm.${confirmKey}.body`)}</p>
        {needsReason && reasonLabel(reason) !== null ? (
          <p className="mt-2 font-medium">
            {t('settings.reason-line', { reason: reasonLabel(reason) ?? '' })}
          </p>
        ) : null}
      </Dialog>
    </SettingsPage>
  );
}
