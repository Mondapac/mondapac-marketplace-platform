'use client';

import { Banner, BackLink, Button, Dialog, RadioGroup, TextAreaField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { ResponseText } from './alerts-list.tsx';
import { SeverityBadge, StateBadge, useAgo, useNow, usePoll } from './parts.tsx';
import {
  minutesBetween,
  NOTE_MAX,
  NOTE_MIN,
  noteLength,
  PAGE_POLL_MS,
  RESOLUTIONS,
  S1_RESPONSE_MS,
  type AlertDelivery,
  type AlertDetail,
  type Resolution,
} from './types.ts';

/** Who may resolve a critical alert, as the roster names them; null without a roster. */
export interface Resolvers {
  readonly commander: string | null;
  readonly owner: string | null;
}

type Notice = { readonly tone: 'info' | 'critical'; readonly text: string } | null;

/**
 * One alert: its clock and escalation, its details, the timeline of every message, and the two
 * acts. Acknowledge is one click (no undo: the API has none). Resolve opens a dialog that keeps
 * the outcome and note when someone else acted first. Focus: after Acknowledge it moves to
 * Resolve, after Resolve to the resolution, after a conflict to the message that explains it.
 */
export function AlertDetailView({
  initial,
  zone,
  canRespond,
  resolvers,
  csrfToken,
  maxSteps,
}: {
  readonly initial: AlertDetail;
  readonly zone: string;
  readonly canRespond: boolean;
  /** Null when there is no on-call roster. */
  readonly resolvers: Resolvers | null;
  readonly csrfToken: string;
  readonly maxSteps: number;
}) {
  const t = useTranslations('security-centre.detail');
  const ts = useTranslations('security-centre');
  const locale = useLocale();
  const ago = useAgo();
  const now = useNow();
  const [alert, setAlert] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [refreshFailedAt, setRefreshFailedAt] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const resolveButton = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const resolutionRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<'resolve' | 'notice' | 'resolution' | null>(null);
  const loadedAt = useRef(new Date().toISOString());
  const time = (iso: string) => formatInstantInZone(iso, locale, zone);
  const nameOr = (name: string | null) => name ?? t('someone');

  useEffect(() => {
    const target =
      focusNext.current === 'resolve'
        ? resolveButton.current
        : focusNext.current === 'notice'
          ? noticeRef.current
          : focusNext.current === 'resolution'
            ? resolutionRef.current
            : null;
    focusNext.current = null;
    target?.focus();
  });

  const reread = async (): Promise<AlertDetail | null> => {
    const result = await callApi<AlertDetail>('GET', `security/admin/alerts/${alert.id}`);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      return null;
    }
    loadedAt.current = new Date().toISOString();
    setAlert(result.body);
    return result.body;
  };

  usePoll(() => {
    if (pending || dialogOpen || alert.state === 'resolved') return;
    const before = alert.state;
    void reread().then((fresh) => {
      setRefreshFailedAt(fresh === null ? loadedAt.current : null);
      if (fresh === null || fresh.state === before) return;
      // Someone else acted: say who, as a conflict does (Reza M10b). Focus moves only when the
      // button that held it has gone with the change.
      setNotice({ tone: 'info', text: changeText(fresh, 'changed') });
      const focused = document.activeElement;
      if (
        focused === null ||
        focused === document.body ||
        focused.closest('[data-acts]') !== null
      ) {
        focusNext.current = 'notice';
      }
    });
  }, PAGE_POLL_MS);

  /** "X acknowledged / resolved this alert …", for a refresh or (with what was lost) a conflict. */
  const changeText = (fresh: AlertDetail, kind: 'changed' | 'conflict') =>
    fresh.state === 'resolved'
      ? t(`${kind}-resolved`, {
          name: nameOr(fresh.resolvedByName),
          when: fresh.resolvedAt === null ? '' : ago(fresh.resolvedAt, Date.now()),
        })
      : fresh.state === 'acknowledged'
        ? t(`${kind}-acknowledged`, {
            name: nameOr(fresh.acknowledgedByName),
            when: fresh.acknowledgedAt === null ? '' : ago(fresh.acknowledgedAt, Date.now()),
          })
        : t('conflict');

  /** Someone acted first: read the alert again and say who did what. */
  const explainConflict = async () => {
    const fresh = await reread();
    setNotice({
      tone: 'info',
      text: fresh === null ? t('conflict') : changeText(fresh, 'conflict'),
    });
    focusNext.current = 'notice';
    return fresh;
  };

  const acknowledge = async () => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    const result = await callApi<AlertDetail>(
      'POST',
      `security/admin/alerts/${alert.id}/acknowledge`,
      { expectedVersion: alert.version },
      csrfToken,
    );
    setPending(false);
    if (result.ok) {
      setAlert(result.body);
      toast.success(t(result.body.severity === 's1' ? 'acknowledged-toast' : 'acknowledged-plain'));
      focusNext.current = 'resolve';
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.status === 409) {
      await explainConflict();
      return;
    }
    setNotice({
      tone: 'critical',
      text: refusalText(result.failure, (key) => t(key)),
    });
    focusNext.current = 'notice';
  };

  const critical = alert.severity === 's1';
  const live = alert.state !== 'resolved';
  const resolveBlock: string | null = !canRespond
    ? t('hint-no-permission')
    : critical && resolvers === null
      ? t('hint-no-roster')
      : critical && !alert.viewerResolvesCritical
        ? resolvers?.commander != null && resolvers.owner != null
          ? t('hint-s1', { commander: resolvers.commander, owner: resolvers.owner })
          : t('hint-s1-unnamed')
        : null;
  const hint = resolveBlock ?? (alert.state === 'open' ? t('hint-open') : null);

  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/security/alerts" label={t('back')} />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <SeverityBadge severity={alert.severity} />
          <StateBadge state={alert.state} />
        </div>
        <h1 className="text-2xl font-semibold">{alert.title}</h1>
        <p className="font-mono text-sm text-fg-muted">{alert.rule}</p>
      </header>

      {notice === null ? null : (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <Banner tone={notice.tone}>{notice.text}</Banner>
        </div>
      )}
      {refreshFailedAt === null ? null : (
        <Banner tone="attention">{t('refresh-failed', { time: time(refreshFailedAt) })}</Banner>
      )}

      <Escalation alert={alert} now={now} resolvers={resolvers} maxSteps={maxSteps} time={time} />

      <section aria-labelledby="alert-details" className="flex flex-col gap-3">
        <h2 id="alert-details" className="text-base font-semibold">
          {t('details')}
        </h2>
        <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm sm:grid-cols-[var(--mp-size-data-label)_minmax(0,1fr)]">
          <dt className="text-fg-muted">{ts(`key.${alert.keyType}`)}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono">{alert.keyValue}</span>
            <CopyButton text={alert.keyValue} label={t('copy-key')} />
          </dd>
          <dt className="text-fg-muted">{t('events')}</dt>
          <dd className="tabular-nums">{alert.eventCount}</dd>
          <dt className="text-fg-muted">{t('first-event')}</dt>
          <dd>{time(alert.firstEventAt)}</dd>
          <dt className="text-fg-muted">{t('last-event')}</dt>
          <dd>{time(alert.lastEventAt)}</dd>
          <dt className="text-fg-muted">{t('opened')}</dt>
          <dd>
            {time(alert.openedAt)} ({ago(alert.openedAt, now)})
          </dd>
        </dl>
      </section>

      {alert.state === 'resolved' && alert.resolution !== null ? (
        <section aria-labelledby="alert-resolution" className="flex flex-col gap-2">
          <h2
            id="alert-resolution"
            ref={resolutionRef}
            tabIndex={-1}
            className="text-base font-semibold outline-none"
          >
            {t('resolution')}
          </h2>
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-4 text-sm">
            <p>
              <span className="font-medium">{ts(`resolution.${alert.resolution}`)}</span>{' '}
              <span className="text-fg-muted">
                {t('resolved-by', {
                  name: nameOr(alert.resolvedByName),
                  when: alert.resolvedAt === null ? '' : time(alert.resolvedAt),
                })}
              </span>
            </p>
            {alert.resolutionNote === null ? null : (
              <p className="whitespace-pre-wrap">{alert.resolutionNote}</p>
            )}
          </div>
        </section>
      ) : null}

      <Timeline alert={alert} time={time} nameOr={nameOr} />

      {live ? (
        <div
          data-acts
          className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-line bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0"
        >
          <div className="flex flex-row gap-3 max-sm:[&>*]:flex-1">
            {alert.state === 'open' ? (
              <Button
                onClick={() => void acknowledge()}
                disabled={!canRespond}
                loading={pending}
                aria-describedby={hint === null ? undefined : 'alert-act-hint'}
              >
                {t('acknowledge')}
              </Button>
            ) : null}
            <Button
              ref={resolveButton}
              variant={alert.state === 'acknowledged' ? 'primary' : 'secondary'}
              disabled={resolveBlock !== null || pending}
              onClick={() => setDialogOpen(true)}
              aria-describedby={hint === null ? undefined : 'alert-act-hint'}
            >
              {t('resolve')}
            </Button>
          </div>
          {hint === null ? null : (
            <p id="alert-act-hint" className="text-sm text-fg-muted">
              {hint}
            </p>
          )}
        </div>
      ) : null}

      <ResolveDialog
        open={dialogOpen}
        alert={alert}
        csrfToken={csrfToken}
        onClose={() => {
          setDialogOpen(false);
          // Closed after someone else resolved it: the Resolve button is gone, so focus goes
          // to the notice that says what happened (Reza S3).
          if (alert.state === 'resolved') {
            setNotice({ tone: 'info', text: changeText(alert, 'changed') });
            focusNext.current = 'notice';
          }
        }}
        onResolved={(resolved) => {
          setAlert(resolved);
          setDialogOpen(false);
          setNotice(null);
          toast.success(t('resolved-toast'));
          focusNext.current = 'resolution';
        }}
        onConflict={async () => {
          const fresh = await reread();
          return fresh;
        }}
        nameOr={nameOr}
        agoNow={(iso) => ago(iso, Date.now())}
      />
    </div>
  );
}

function Escalation({
  alert,
  now,
  resolvers,
  maxSteps,
  time,
}: {
  readonly alert: AlertDetail;
  readonly now: number;
  readonly resolvers: Resolvers | null;
  readonly maxSteps: number;
  readonly time: (iso: string) => string;
}) {
  const t = useTranslations('security-centre.detail');
  const ago = useAgo();
  const box = 'flex flex-col gap-2 rounded-lg border p-4 text-sm';
  if (alert.state === 'acknowledged') {
    return (
      <div className={`${box} border-line bg-subtle`}>
        <p className="font-semibold">{t('stopped-title')}</p>
        <p>
          {t('stopped', {
            name: alert.acknowledgedByName ?? t('someone'),
            when: alert.acknowledgedAt === null ? '' : ago(alert.acknowledgedAt, now),
          })}
        </p>
      </div>
    );
  }
  if (alert.state !== 'open') return null;
  if (alert.severity === 's1') {
    const open = minutesBetween(alert.openedAt, now);
    const left = Math.ceil((Date.parse(alert.openedAt) + S1_RESPONSE_MS - now) / 60_000);
    const share = Math.min(100, (open / 15) * 100);
    return (
      <div className={`${box} border-critical-border bg-critical-bg text-critical-fg`}>
        <div className="flex flex-wrap justify-between gap-2">
          <p className="font-semibold">{t('respond-title')}</p>
          <p className="font-medium tabular-nums">
            {left > 0
              ? t('respond-left', { minutes: open, left })
              : t('respond-overdue', { minutes: open, over: -left })}
          </p>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden="true">
          <div className="h-full bg-critical-solid" style={{ width: `${share}%` }} />
        </div>
        <p className="text-fg">
          {resolvers === null
            ? t('no-roster')
            : alert.nextNotifyAt === null
              ? t('escalation-done', { step: alert.notifyStep, max: maxSteps })
              : t('escalation', {
                  step: alert.notifyStep,
                  max: maxSteps,
                  when: time(alert.nextNotifyAt),
                })}
        </p>
      </div>
    );
  }
  if (alert.severity === 's2') {
    return resolvers === null ? (
      <div className={`${box} border-critical-border bg-critical-bg text-critical-fg`}>
        <p>{t('no-roster')}</p>
      </div>
    ) : alert.nextNotifyAt === null ? null : (
      <div className={`${box} border-line bg-subtle`}>
        <p className="font-semibold">{t('waiting-title')}</p>
        <p>{t('waiting', { when: time(alert.nextNotifyAt) })}</p>
      </div>
    );
  }
  return (
    <p className="text-sm text-fg-muted">
      <ResponseText alert={alert} now={now} noRoster={false} />
    </p>
  );
}

const OUTCOME_DOT: Record<AlertDelivery['outcome'], string> = {
  sent: 'bg-success-fg',
  failed: 'bg-critical-solid',
  'not-configured': 'bg-attention-solid',
  'no-contact': 'bg-attention-solid',
};

function Timeline({
  alert,
  time,
  nameOr,
}: {
  readonly alert: AlertDetail;
  readonly time: (iso: string) => string;
  readonly nameOr: (name: string | null) => string;
}) {
  const t = useTranslations('security-centre.detail');
  const ts = useTranslations('security-centre');
  const entries: { key: string; dot: string; title: string; sub: string }[] = [
    {
      key: 'opened',
      dot: 'bg-info-fg',
      title: t('tl-opened'),
      sub: `${time(alert.openedAt)} · ${t('tl-opened-sub', { count: alert.eventCount, first: time(alert.firstEventAt) })}`,
    },
    ...alert.deliveries.map((delivery, index) => ({
      key: `d${index}`,
      dot: OUTCOME_DOT[delivery.outcome],
      title: `${t('tl-delivery', {
        channel: ts(`channel.${delivery.channel}`),
        recipient: delivery.recipient,
      })} · ${t(`tl-outcome.${delivery.outcome}`)}`,
      sub: `${time(delivery.at)} · ${t('tl-step', { step: delivery.step })}`,
    })),
  ];
  if (alert.acknowledgedAt !== null) {
    entries.push({
      key: 'ack',
      dot: 'bg-info-fg',
      title: t('tl-acknowledged', { name: nameOr(alert.acknowledgedByName) }),
      sub: time(alert.acknowledgedAt),
    });
  }
  if (alert.resolvedAt !== null && alert.resolution !== null) {
    entries.push({
      key: 'res',
      dot: 'bg-success-fg',
      title: t('tl-resolved', {
        name: nameOr(alert.resolvedByName),
        resolution: ts(`resolution.${alert.resolution}`),
      }),
      sub: time(alert.resolvedAt),
    });
  }
  if (alert.state !== 'resolved' && (alert.severity === 's3' || alert.severity === 's4')) {
    entries.push({
      key: 'digest',
      dot: 'bg-fg-muted',
      title: t(alert.severity === 's3' ? 'tl-digest-s3' : 'tl-digest-s4'),
      sub: '',
    });
  }
  const unconfigured = alert.deliveries.some((delivery) => delivery.outcome === 'not-configured');
  return (
    <section aria-labelledby="alert-timeline" className="flex flex-col gap-3">
      <h2 id="alert-timeline" className="text-base font-semibold">
        {t('timeline')}
      </h2>
      <ol className="flex flex-col gap-3 text-sm">
        {entries.map((entry) => (
          <li key={entry.key} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3">
            <span className={`mt-1.5 size-2.5 rounded-full ${entry.dot}`} aria-hidden="true" />
            <div>
              <p>{entry.title}</p>
              {entry.sub === '' ? null : <p className="text-fg-muted">{entry.sub}</p>}
            </div>
          </li>
        ))}
      </ol>
      {unconfigured ? <p className="text-sm text-fg-muted">{t('channels-note')}</p> : null}
    </section>
  );
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const t = useTranslations('security-centre.detail');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        aria-label={label}
        onClick={() => {
          const write = navigator.clipboard?.writeText(text);
          if (write === undefined) {
            setState('failed');
            return;
          }
          void write.then(() => setState('copied')).catch(() => setState('failed'));
        }}
      >
        {state === 'copied' ? t('copied') : t('copy')}
      </Button>
      {/* Said, not only shown (Reza S11). */}
      <span role="status" className={state === 'failed' ? 'text-sm text-critical-fg' : 'sr-only'}>
        {state === 'copied' ? t('copied') : state === 'failed' ? t('copy-failed') : ''}
      </span>
    </span>
  );
}

function ResolveDialog({
  open,
  alert,
  csrfToken,
  onClose,
  onResolved,
  onConflict,
  nameOr,
  agoNow,
}: {
  readonly open: boolean;
  readonly alert: AlertDetail;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onResolved: (alert: AlertDetail) => void;
  readonly onConflict: () => Promise<AlertDetail | null>;
  readonly nameOr: (name: string | null) => string;
  readonly agoNow: (iso: string) => string;
}) {
  const t = useTranslations('security-centre.resolve');
  const ts = useTranslations('security-centre');
  const td = useTranslations('security-centre.detail');
  const [outcome, setOutcome] = useState<Resolution | ''>('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [closedBySomeone, setClosedBySomeone] = useState(false);
  const [pending, setPending] = useState(false);

  // Every opening starts clean; a conflict keeps what was typed (Reza M3).
  useEffect(() => {
    if (!open) return;
    setOutcome('');
    setNote('');
    setTouched(false);
    setProblem(null);
    setClosedBySomeone(false);
  }, [open]);

  const length = noteLength(note);
  const ready = outcome !== '' && length >= NOTE_MIN && length <= NOTE_MAX;
  const noteError = touched && length > 0 && length < NOTE_MIN ? t('note-short') : undefined;

  const submit = async () => {
    if (!ready || pending || closedBySomeone) return;
    setPending(true);
    setProblem(null);
    const result = await callApi<AlertDetail>(
      'POST',
      `security/admin/alerts/${alert.id}/resolve`,
      { expectedVersion: alert.version, resolution: outcome, note: note.trim() },
      csrfToken,
    );
    setPending(false);
    if (result.ok) {
      onResolved(result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.status === 409) {
      const fresh = await onConflict();
      if (fresh?.state === 'resolved') {
        setClosedBySomeone(true);
        setProblem(
          t('conflict-resolved', {
            name: nameOr(fresh.resolvedByName),
            when: fresh.resolvedAt === null ? '' : agoNow(fresh.resolvedAt),
          }),
        );
      } else {
        setProblem(
          fresh === null
            ? td('conflict')
            : t('conflict-acknowledged', { name: nameOr(fresh.acknowledgedByName) }),
        );
      }
      return;
    }
    setProblem(refusalText(result.failure, (key) => td(key)));
  };

  return (
    <Dialog
      open={open}
      size="form"
      title={t('title')}
      onClose={onClose}
      actions={
        closedBySomeone ? (
          <>
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard?.writeText(note.trim()).catch(() => undefined)
              }
            >
              {t('copy-note')}
            </Button>
            <Button onClick={onClose}>{t('cancel')}</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={!ready}
              loading={pending}
              aria-describedby={ready ? undefined : 'resolve-why'}
            >
              {t('submit')}
            </Button>
          </>
        )
      }
      actionsNote={
        ready || closedBySomeone ? null : <span id="resolve-why">{t('submit-why')}</span>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{t('intro', { title: alert.title })}</p>
        {problem === null ? null : (
          <Banner tone={closedBySomeone ? 'attention' : 'info'}>{problem}</Banner>
        )}
        <RadioGroup
          legend={t('outcome')}
          name="security-resolution"
          value={outcome}
          disabled={closedBySomeone}
          onChange={(value) => setOutcome(value as Resolution)}
          options={RESOLUTIONS.map((value) => ({
            value,
            label: ts(`resolution.${value}`),
            help: ts(`resolution-help.${value}`),
          }))}
        />
        <TextAreaField
          label={t('note')}
          value={note}
          rows={4}
          maxLength={NOTE_MAX}
          disabled={closedBySomeone}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => setTouched(true)}
          help={t('note-help')}
          error={noteError}
          counter={t('counter', { count: length })}
        />
      </div>
    </Dialog>
  );
}

/** What a refused act says, by the API's code: a 403 is not always an acting-as session. */
function refusalText(
  failure: { readonly status: number; readonly code: string },
  t: (key: 'denied' | 's1-only' | 'error') => string,
): string {
  if (failure.code === 'security.s1-resolver-only') return t('s1-only');
  if (failure.status === 403 && failure.code === 'access.denied') return t('denied');
  return t('error');
}
