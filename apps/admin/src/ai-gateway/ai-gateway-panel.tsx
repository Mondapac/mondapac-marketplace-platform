'use client';

import {
  Badge,
  Banner,
  Button,
  Select,
  SettingRow,
  SettingsPage,
  SettingsSection,
  Switch,
  TextAreaField,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import { REVIEW_NOTE_MAX, isNoteFailure, useSentForReview } from '../shared/review-note.tsx';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { gatewayProblemOf } from './errors.ts';
import {
  CAPABILITY_CODES,
  CAP_CODES,
  GATEWAY_CAPABILITIES_PATH,
  GATEWAY_HISTORY_PATH,
  GATEWAY_LIMITS_PATH,
  GATEWAY_PATH,
  GATEWAY_REVERT_PATH,
  GATEWAY_STOP_PATH,
  HISTORY_CODES,
  NEVER_NONE,
  STOP_CODE,
  dollarsToMicro,
  find,
  historyOf,
  microToDollars,
  settingsOf,
  type GatewaySetting,
  type HistoryEntry,
} from './types.ts';

type Busy = 'stop' | 'capability' | 'limits' | 'revert' | null;

/**
 * Settings › AI Gateway: the Market's AI emergency stop, the switch of each AI capability, the
 * spending caps, and the history of each of those with a restore. Every write sends the version
 * the admin saw and the answer drives the screen (nothing is optimistic). The server decides what
 * needs a fresh two-step code (switching on, raising a cap, resuming, every restore); the shared
 * step-up dialog asks in place. A note is always sent for the emergency stop and for a restore of
 * it, and wherever the API says a change is reviewed.
 */
export function AiGatewayPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: readonly GatewaySetting[];
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('ai-gateway');
  const root = useTranslations();
  const locale = useLocale();
  const guarded = useGuardedCall();
  const sentForReview = useSentForReview();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [historyCode, setHistoryCode] = useState<string>(STOP_CODE);
  const [history, setHistory] = useState<readonly HistoryEntry[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);

  const stop = find(rows, STOP_CODE);
  const stopOn = stop.value === 'on';
  const noteText = note.trim();
  const reviewed = rows.some((row) => row.review?.reviewed === true);

  const capText = (code: string): string => {
    const draft = drafts[code];
    return draft ?? microToDollars(find(rows, code).value);
  };
  const changedCaps = CAP_CODES.filter((code) => drafts[code] !== undefined);

  async function reload(): Promise<boolean> {
    const fresh = await callApi<unknown>('GET', GATEWAY_PATH);
    if (!fresh.ok && fresh.failure.status === 401) {
      window.location.assign('/session-ended');
      return false;
    }
    const next = fresh.ok ? settingsOf(fresh.body) : null;
    if (next !== null) setRows(next);
    return next !== null;
  }

  /** Runs one write; true when it was saved. Handles sign-out, conflicts, notes and errors. */
  async function write(
    kind: Exclude<Busy, null>,
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
  ): Promise<boolean> {
    if (busy !== null) return false;
    setBusy(kind);
    setProblem(null);
    setNoteError(null);
    const result = await guarded<unknown>(method, path, body, csrfToken);
    if (result.ok) {
      await reload();
      setNote('');
      toast.success(t('saved'));
      sentForReview(result.body);
      setBusy(null);
      return true;
    }
    if (!isStepUpCancelled(result)) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
      } else if (isNoteFailure(result.failure)) {
        setNoteError('rejected');
      } else {
        const key = gatewayProblemOf(result.failure);
        setProblem(key);
        if (key === 'conflict') await reload();
      }
    }
    setBusy(null);
    return false;
  }

  /** The note is needed for the stop, and where a change is reviewed. */
  function needNote(always: boolean): string | null | false {
    if (noteText === '' && (always || reviewed)) {
      setNoteError('required');
      return false;
    }
    return noteText === '' ? null : noteText;
  }

  async function switchStop() {
    const sent = needNote(true);
    if (sent === false || sent === null) return;
    await write('stop', 'PUT', GATEWAY_STOP_PATH, {
      value: stopOn ? 'off' : 'on',
      expectedVersion: stop.version,
      note: sent,
    });
  }

  async function switchCapability(code: string, on: boolean) {
    const sent = needNote(false);
    if (sent === false) return;
    await write('capability', 'PUT', GATEWAY_CAPABILITIES_PATH, {
      changes: [{ code, value: on ? 'on' : 'off', expectedVersion: find(rows, code).version }],
      ...(sent === null ? {} : { note: sent }),
    });
  }

  async function saveLimits() {
    const errors: Record<string, string> = {};
    const changes: { code: string; value: string; expectedVersion: number }[] = [];
    for (const code of changedCaps) {
      const micro = dollarsToMicro(drafts[code] ?? '', !NEVER_NONE.includes(code));
      if (micro === null) errors[code] = 'invalid';
      else changes.push({ code, value: micro, expectedVersion: find(rows, code).version });
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || changes.length === 0) return;
    const sent = needNote(false);
    if (sent === false) return;
    const saved = await write('limits', 'PUT', GATEWAY_LIMITS_PATH, {
      changes,
      ...(sent === null ? {} : { note: sent }),
    });
    if (saved) setDrafts({});
  }

  async function loadHistory(code: string) {
    setHistoryCode(code);
    setHistory(null);
    setHistoryFailed(false);
    const answer = await callApi<unknown>(
      'GET',
      `${GATEWAY_HISTORY_PATH}?code=${encodeURIComponent(code)}`,
    );
    if (!answer.ok && answer.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const entries = answer.ok ? historyOf(answer.body) : null;
    if (entries === null) setHistoryFailed(true);
    else setHistory(entries);
  }

  async function restore(version: number) {
    const sent = needNote(historyCode === STOP_CODE);
    if (sent === false) return;
    const saved = await write('revert', 'POST', GATEWAY_REVERT_PATH, {
      code: historyCode,
      version,
      expectedVersion: find(rows, historyCode).version,
      ...(sent === null ? {} : { note: sent }),
    });
    if (saved) await loadHistory(historyCode);
  }

  const disabled = !canManage || busy !== null;
  const label = (code: string) => t(`code.${code}`);
  const showValue = (code: string, value: string | null): string => {
    if (value === null) return t('history.default');
    if (code === STOP_CODE || code.startsWith('ai-capability-')) return t(`state.${value}`);
    return value === 'none' ? t('cap.none') : `US$${microToDollars(value)}`;
  };

  const banners = [
    stopOn ? (
      <Banner key="stop" tone="critical" title={t('stop.on-title')}>
        <p>{t('stop.on-body')}</p>
      </Banner>
    ) : null,
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t('read-only')}
      </Banner>
    ),
    problem === null ? null : (
      <Banner key="problem" tone={problem === 'conflict' ? 'attention' : 'critical'}>
        {t(`error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t('title')}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
    >
      {canManage ? (
        <SettingsSection title={t('note.section')} description={t('note.intro')}>
          <div className="px-5 py-4">
            <TextAreaField
              label={t('note.label')}
              help={t('note.help', { max: REVIEW_NOTE_MAX })}
              error={noteError === null ? undefined : t(`note.error.${noteError}`)}
              rows={2}
              value={note}
              maxLength={REVIEW_NOTE_MAX}
              disabled={busy !== null}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection title={t('stop.section')} description={t('stop.intro')}>
        <SettingRow
          id="ai-gateway-stop"
          settingId="ai-gateway-emergency-stop"
          label={t('stop.label')}
          help={t('stop.help')}
          plain
        >
          <div className="flex items-center gap-3">
            <Badge tone={stopOn ? 'critical' : 'success'}>
              {stopOn ? t('stop.badge-on') : t('stop.badge-off')}
            </Badge>
            {canManage ? (
              <Button
                variant={stopOn ? 'secondary' : 'destructive-solid'}
                disabled={disabled}
                onClick={() => void switchStop()}
              >
                {stopOn ? t('stop.resume') : t('stop.switch-on')}
              </Button>
            ) : null}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('capabilities.section')} description={t('capabilities.intro')}>
        {CAPABILITY_CODES.map((code) => {
          const row = find(rows, code);
          const on = row.value !== 'off';
          return (
            <SettingRow
              key={code}
              id={`cap-${code}`}
              settingId={code}
              label={label(code)}
              help={`${t(`capabilities.help.${code}`)} ${
                row.updatedAt === null
                  ? t('never-changed')
                  : t('last-changed', { when: formatInstant(row.updatedAt, locale) })
              }`}
              plain
            >
              <div className="flex items-center gap-3">
                <Switch
                  aria-label={label(code)}
                  checked={on}
                  disabled={disabled}
                  onCheckedChange={(next) => void switchCapability(code, next)}
                />
                <span aria-live="polite">{on ? t('state.on') : t('state.off')}</span>
              </div>
            </SettingRow>
          );
        })}
        {canManage ? (
          <p className="px-5 py-3 text-sm text-fg-muted">{root('step-up.wait-note')}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t('limits.section')} description={t('limits.intro')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          {CAP_CODES.map((code) => {
            const error = fieldErrors[code];
            return (
              <TextField
                key={code}
                label={label(code)}
                help={t(NEVER_NONE.includes(code) ? 'limits.help-no-none' : 'limits.help')}
                prefix="US$"
                inputMode="decimal"
                value={capText(code)}
                disabled={disabled}
                error={error === undefined ? undefined : t('limits.invalid')}
                onChange={(event) => {
                  const next = event.target.value;
                  const saved = microToDollars(find(rows, code).value);
                  setDrafts((current) => {
                    const rest = Object.fromEntries(
                      Object.entries(current).filter(([key]) => key !== code),
                    );
                    return next.trim() === saved ? rest : { ...rest, [code]: next };
                  });
                  setFieldErrors((current) =>
                    Object.fromEntries(Object.entries(current).filter(([key]) => key !== code)),
                  );
                }}
              />
            );
          })}
          {canManage ? (
            <div>
              <Button
                className="w-full sm:w-auto"
                disabled={disabled || changedCaps.length === 0}
                onClick={() => void saveLimits()}
              >
                {t('limits.save')}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title={t('history.section')} description={t('history.intro')}>
        <div className="flex flex-col gap-4 px-5 py-4">
          <Select
            label={t('history.setting')}
            options={HISTORY_CODES.map((code) => ({ value: code, label: label(code) }))}
            value={historyCode}
            onChange={(event) => {
              setHistory(null);
              setHistoryFailed(false);
              setHistoryCode(event.target.value);
            }}
          />
          <div>
            <Button variant="secondary" onClick={() => void loadHistory(historyCode)}>
              {t('history.show')}
            </Button>
          </div>
          {historyFailed ? <Banner tone="critical">{t('history.failed')}</Banner> : null}
          {history !== null && history.length === 0 ? (
            <p className="text-sm">{t('history.empty')}</p>
          ) : null}
          {history !== null && history.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line" aria-label={t('history.list')}>
              {history.map((entry) => (
                <li
                  key={entry.version}
                  className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex-1 text-sm">
                    <p>
                      {t('history.change', {
                        version: entry.version,
                        before: showValue(entry.code, entry.previousValue),
                        after: showValue(entry.code, entry.value),
                      })}
                      {entry.current ? <Badge tone="info">{t('history.current')}</Badge> : null}
                    </p>
                    <p className="text-fg-muted">
                      {t('history.by-at', {
                        name: entry.changedBy ?? t('history.unknown'),
                        when: formatInstant(entry.changedAt, locale),
                      })}
                      {entry.note === null ? '' : ` · ${entry.note}`}
                    </p>
                  </div>
                  {canManage && !entry.current ? (
                    <Button
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => void restore(entry.version)}
                    >
                      {t('history.restore', { version: entry.version })}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {history !== null && history.length >= 50 ? (
            <p className="text-sm text-fg-muted">{t('history.capped')}</p>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
