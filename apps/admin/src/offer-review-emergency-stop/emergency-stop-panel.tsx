'use client';

import { Banner, Button, Dialog, SettingsPage, SettingsSection, TextAreaField } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { EMERGENCY_STOP_PATH, MAX_REASON, emergencyStopOf, type EmergencyStop } from './types.ts';

type Problem = 'reason' | 'conflict' | 'denied' | 'unknown';

/**
 * Settings › Catalogue › Emergency stop (R0, design 9.5 b): the switch that sends every new Offer
 * of the Market to an admin, even from a Trusted seller, while live Offers stay live. Switching
 * needs the protected key (a fresh two-step code) and a reason, every time; nothing switches it
 * off by itself. A holder of the view key alone sees the state only.
 */
export function EmergencyStopPanel({
  initial,
  canSwitch,
  csrfToken,
  zone,
}: {
  readonly initial: EmergencyStop;
  readonly canSwitch: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('emergency-stop.page');
  const format = useFormatter();
  const guarded = useGuardedCall();
  const [stop, setStop] = useState(initial);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);

  const when =
    stop.changedAt === null
      ? null
      : format.dateTime(new Date(stop.changedAt), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: zone,
        });

  async function reload() {
    const fresh = await callApi<unknown>('GET', EMERGENCY_STOP_PATH);
    const parsed = fresh.ok ? emergencyStopOf(fresh.body) : null;
    if (parsed !== null) setStop(parsed);
  }

  /** Turning on says what it does first (Reza); turning off goes straight through. */
  function ask() {
    const note = reason.trim();
    if (note.length === 0 || note.length > MAX_REASON) {
      setProblem('reason');
      return;
    }
    if (stop.on) void toggle();
    else setConfirming(true);
  }

  async function toggle() {
    setConfirming(false);
    const note = reason.trim();
    setBusy(true);
    setProblem(null);
    const answer = await guarded<unknown>(
      'PUT',
      EMERGENCY_STOP_PATH,
      { value: stop.on ? 'off' : 'on', expectedVersion: stop.version, note },
      csrfToken,
    );
    setBusy(false);
    if (answer.ok) {
      setReason('');
      await reload();
      return;
    }
    if (isStepUpCancelled(answer)) return;
    if (answer.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (answer.failure.code === 'settings.conflict') {
      await reload();
      setProblem('conflict');
    } else if (answer.failure.code === 'validation.failed') setProblem('reason');
    else if (answer.failure.code === 'access.denied') setProblem('denied');
    else setProblem('unknown');
  }

  return (
    <SettingsPage title={t('title')}>
      <SettingsSection title={t('section')} description={t('intro')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          <Banner
            tone={stop.on ? 'critical' : 'info'}
            title={stop.on ? t('state-on') : t('state-off')}
          >
            {stop.on ? <p>{t('on-body')}</p> : <p>{t('off-body')}</p>}
            {when !== null ? (
              <p className="mt-1">
                {stop.changedBy !== null
                  ? t('last-by-at', { name: stop.changedBy, when })
                  : t('last-at', { when })}
              </p>
            ) : null}
          </Banner>
          {canSwitch ? (
            <>
              <TextAreaField
                label={t('reason-label')}
                help={t('reason-help')}
                error={problem === 'reason' ? t('reason-required') : undefined}
                rows={3}
                value={reason}
                maxLength={MAX_REASON}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (problem === 'reason') setProblem(null);
                }}
              />
              {problem !== null && problem !== 'reason' ? (
                <Banner tone="critical">
                  <p>{t(`problem.${problem}`)}</p>
                </Banner>
              ) : null}
              <div>
                <Button
                  variant={stop.on ? 'secondary' : 'destructive-solid'}
                  className="w-full sm:w-auto"
                  disabled={busy}
                  onClick={ask}
                >
                  {stop.on ? t('turn-off') : t('turn-on')}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm">{t('view-only')}</p>
          )}
        </div>
      </SettingsSection>
      <Dialog
        open={confirming}
        title={t('confirm-title')}
        onClose={() => setConfirming(false)}
        initialFocus={cancel}
        actions={
          <>
            <Button ref={cancel} variant="secondary" onClick={() => setConfirming(false)}>
              {t('confirm-cancel')}
            </Button>
            <Button variant="destructive-solid" onClick={() => void toggle()}>
              {t('confirm-turn-on')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t('confirm-body')}</p>
      </Dialog>
    </SettingsPage>
  );
}
