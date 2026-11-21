'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  SaveBar,
  SettingsPage,
  SettingsSection,
  Switch,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { shipToRetentionProblemOf } from './errors.ts';
import { monthsOf, needsConfirm } from './form.ts';
import { MAX_MONTHS, MIN_MONTHS, SHIP_TO_RETENTION_PATH, type ShipToRetention } from './types.ts';

/**
 * Settings › Order address retention: whether the sealed delivery address of an order is
 * deleted for good a number of months after the order was completed (delivered, cancelled, refunded in full, or shipped but never delivered). Off by default.
 * Turning it on or shortening the wait asks for a confirmation first, because the deletion is
 * permanent. The write is a guarded call (protected manage key, may ask a code); the version sent
 * is the one shown, so a stale save answers 409 and the admin reloads the latest. Without the
 * manage key the page is read-only.
 */
export function ShipToRetentionPanel({
  initial,
  canManage,
  csrfToken,
  zone,
}: {
  readonly initial: ShipToRetention;
  readonly canManage: boolean;
  readonly csrfToken: string;
  /** The IANA zone the update time is shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('ship-to-retention');
  const tr = useTranslations();
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [months, setMonths] = useState(String(initial.months));
  const [monthsError, setMonthsError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    if (failures > 0) alertRef.current?.focus();
  }, [failures]);

  const parsed = monthsOf(months);
  const effectiveMonths = enabled ? (parsed ?? saved.months) : saved.months;
  const switchChanged = enabled !== saved.enabled;
  const monthsChanged = enabled && parsed !== saved.months;
  const count = canManage ? Number(switchChanged) + Number(monthsChanged) : 0;
  const dirty = count > 0;

  function discard() {
    adopt(saved);
    setProblem(null);
  }

  function adopt(next: ShipToRetention) {
    setSaved(next);
    setEnabled(next.enabled);
    setMonths(String(next.months));
    setMonthsError(false);
  }

  function submit() {
    if (enabled && parsed === null) {
      setMonthsError(true);
      return;
    }
    setMonthsError(false);
    if (needsConfirm(saved, { enabled, months: effectiveMonths })) setConfirming(true);
    else void save();
  }

  async function save() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await guarded<ShipToRetention>(
      'PUT',
      SHIP_TO_RETENTION_PATH,
      { enabled, months: effectiveMonths, expectedVersion: saved.version },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    setConfirming(false);
    if (result.ok) {
      adopt(result.body);
      toast.success(t('saved'));
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(shipToRetentionProblemOf(result.failure));
    setFailures((n) => n + 1);
  }

  async function reload() {
    const fresh = await callApi<ShipToRetention>('GET', SHIP_TO_RETENTION_PATH);
    if (fresh.ok) {
      adopt(fresh.body);
      setProblem(null);
    } else if (fresh.failure.status === 401) window.location.assign('/session-ended');
  }

  const confirmDialog = canManage ? (
    <Dialog
      open={confirming}
      title={t('confirm.title')}
      onClose={() => setConfirming(false)}
      actions={
        <>
          <Button
            variant="secondary"
            className="min-h-12"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button className="min-h-12" onClick={() => void save()} loading={pending}>
            {t('confirm.yes')}
          </Button>
        </>
      }
    >
      <p className="text-sm">{t('confirm.body', { months: effectiveMonths })}</p>
    </Dialog>
  ) : null;

  return (
    <SettingsPage
      title={t('title')}
      onSubmit={canManage ? submit : undefined}
      dirty={dirty}
      dirtyCount={count}
      leave={{
        title: tr('settings.leave.title'),
        message: (info) => tr('settings.leave.message', { count: info.count, page: info.page }),
        stay: tr('settings.leave.stay'),
        leave: tr('settings.leave.leave'),
      }}
      saveBar={
        canManage ? (
          <SaveBar
            count={count}
            summary={tr('settings.bar.summary', { count })}
            errorCount={monthsError && enabled && parsed === null ? 1 : 0}
            errorsSummary={tr('settings.bar.errors', { count: 1 })}
            saving={pending}
            labels={{
              region: tr('settings.bar.region'),
              discard: tr('settings.bar.discard'),
              save: tr('settings.bar.save'),
              saving: tr('settings.bar.saving'),
            }}
            onDiscard={discard}
          />
        ) : null
      }
      overlay={confirmDialog}
    >
      <SettingsSection title={t('section')} description={canManage ? t('intro') : t('read-only')}>
        <div className="flex flex-col gap-4 p-5">
          <Banner tone="attention">{t('permanent')}</Banner>
          {problem === null ? null : (
            <div ref={alertRef} tabIndex={-1} className="outline-none">
              <Banner tone="critical">
                {t(`error.${problem}`)}
                {problem === 'stale' ? (
                  <>
                    {' '}
                    <Button variant="secondary" onClick={() => void reload()}>
                      {t('reload')}
                    </Button>
                  </>
                ) : null}
              </Banner>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Switch
              aria-label={t('switch')}
              checked={enabled}
              disabled={!canManage || pending}
              onCheckedChange={setEnabled}
            />
            <span>{t('switch')}</span>
            <Badge tone={saved.enabled ? 'attention' : 'neutral'}>
              {saved.enabled ? t('state-on') : t('state-off')}
            </Badge>
          </div>
          {enabled ? (
            <TextField
              name="months"
              label={t('months')}
              help={t('months-help', { min: MIN_MONTHS, max: MAX_MONTHS })}
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              disabled={!canManage || pending}
              value={months}
              error={
                monthsError ? t('error.months', { min: MIN_MONTHS, max: MAX_MONTHS }) : undefined
              }
              onChange={(event) => setMonths(event.target.value)}
            />
          ) : null}
          <p className="m-0 text-sm text-fg-muted">
            {saved.version === 0 || saved.updatedAt === null
              ? t('never-set')
              : t('updated', {
                  version: saved.version,
                  when: formatInstantInZone(saved.updatedAt, locale, zone),
                })}
          </p>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
