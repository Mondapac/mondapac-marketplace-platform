'use client';

import { Banner, Button, CARD_TABLE, EmptyState, LoadError, SkeletonRows } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { SeverityBadge, StateBadge, useAgo, useNow, usePoll } from './parts.tsx';
import {
  minutesBetween,
  PAGE_POLL_MS,
  PAGE_SIZE,
  rulesStale,
  S1_RESPONSE_MS,
  SEVERITIES,
  stateQuery,
  STATE_FILTERS,
  type AlertPage,
  type AlertSummary,
  type Severity,
  type StateFilter,
  type Summary,
} from './types.ts';

const ALL_SEVERITIES: ReadonlySet<Severity> = new Set(SEVERITIES);

type Failure = 'first' | 'refresh' | 'more' | null;

/**
 * The Alerts tab: the live counts, the banners that say the system is not working (no roster,
 * rules stopped), and the alerts by severity then newest, with state and severity filters. It
 * reads again every 30 s while visible (F4); a refresh replaces data in place, keeps the order of
 * the rows already shown, never moves focus, and keeps the last list when it fails.
 */
export function AlertsList({ zone }: { readonly zone: string }) {
  const t = useTranslations('security-centre');
  const tl = useTranslations('load');
  const locale = useLocale();
  const ago = useAgo();
  const now = useNow();
  const [stateFilter, setStateFilter] = useState<StateFilter>('live');
  const [severities, setSeverities] = useState<ReadonlySet<Severity>>(ALL_SEVERITIES);
  const [rows, setRows] = useState<readonly AlertSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rosterSet, setRosterSet] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<Failure>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const latest = useRef(0);
  const lastCritical = useRef<number | null>(null);

  const query = useCallback(
    (after: string | null, limit: number) => {
      const params = new URLSearchParams({ limit: String(limit) });
      const state = stateQuery(stateFilter);
      if (state !== '') params.set('state', state);
      if (severities.size < SEVERITIES.length) params.set('severity', [...severities].join(','));
      if (after !== null) params.set('after', after);
      return `security/admin/alerts?${params.toString()}`;
    },
    [stateFilter, severities],
  );

  const readSummary = useCallback(async () => {
    const [counts, onCall] = await Promise.all([
      callApi<Summary>('GET', 'security/admin/summary'),
      callApi<{ readonly configured: boolean }>('GET', 'security/admin/on-call'),
    ]);
    if (counts.ok) {
      const critical = counts.body.live.s1;
      if (lastCritical.current !== null && critical > lastCritical.current) {
        setAnnounce(t('badge.announce'));
      }
      lastCritical.current = critical;
      setSummary(counts.body);
    }
    if (onCall.ok) setRosterSet(onCall.body.configured);
    return counts.ok;
  }, [t]);

  /** The first page of the current filters; `refresh` keeps what is shown when it fails. */
  const loadFirst = useCallback(
    async (refresh: boolean) => {
      const ticket = ++latest.current;
      if (!refresh) {
        setLoading(true);
        setRows([]);
        setNext(null);
      }
      const [page, summaryOk] = await Promise.all([
        callApi<AlertPage>('GET', query(null, PAGE_SIZE)),
        readSummary(),
      ]);
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!page.ok) {
        if (page.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailed(refresh ? 'refresh' : 'first');
        return;
      }
      setFailed(summaryOk ? null : 'refresh');
      setLoadedAt(new Date().toISOString());
      setRows((current) => {
        if (!refresh) return page.body.alerts;
        // In place: rows already shown keep their place and take the new data; new alerts go first.
        const fresh = new Map(page.body.alerts.map((alert) => [alert.id, alert]));
        const kept = current.map((alert) => fresh.get(alert.id) ?? alert);
        const known = new Set(current.map((alert) => alert.id));
        return [...page.body.alerts.filter((alert) => !known.has(alert.id)), ...kept];
      });
      if (!refresh) setNext(page.body.next);
    },
    [query, readSummary],
  );

  const loadMore = async () => {
    if (next === null) return;
    const ticket = ++latest.current;
    setLoading(true);
    const page = await callApi<AlertPage>('GET', query(next, PAGE_SIZE));
    if (ticket !== latest.current) return;
    setLoading(false);
    if (!page.ok) {
      setFailed('more');
      return;
    }
    setFailed(null);
    setRows((current) => {
      const known = new Set(current.map((alert) => alert.id));
      return [...current, ...page.body.alerts.filter((alert) => !known.has(alert.id))];
    });
    setNext(page.body.next);
  };

  useEffect(() => {
    void loadFirst(false);
  }, [loadFirst]);

  usePoll(() => {
    if (!loading) void loadFirst(true);
  }, PAGE_POLL_MS);

  const toggleSeverity = (severity: Severity) =>
    setSeverities((current) => {
      const nextSet = new Set(current);
      if (nextSet.has(severity)) nextSet.delete(severity);
      else nextSet.add(severity);
      return nextSet.size === 0 ? ALL_SEVERITIES : nextSet;
    });

  const stale = summary !== null && rulesStale(summary.rulesLastRanAt, now);
  const staleMinutes =
    summary?.rulesLastRanAt == null ? null : minutesBetween(summary.rulesLastRanAt, now);
  const noRoster = rosterSet === false;
  const timeOf = (iso: string) => shortInstantInZone(iso, locale, zone);

  return (
    <div className="flex flex-col gap-4">
      {/* Polite and kept mounted: a refresh does not read the same news again. */}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg-muted">
        <span>
          {summary === null
            ? null
            : summary.rulesLastRanAt === null
              ? t('rules-never')
              : t('rules-ran', { when: ago(summary.rulesLastRanAt, now) })}
          {summary === null ? null : ' · '}
          {t('updates')}
        </span>
        <span>{t('zone-note', { zone })}</span>
      </div>
      {noRoster ? (
        <Banner tone="critical" title={t('banner.no-roster-title')}>
          {t('banner.no-roster')}
        </Banner>
      ) : null}
      {stale ? (
        <Banner tone="attention" title={t('banner.stale-title', { minutes: staleMinutes ?? '–' })}>
          {t('banner.stale')}
        </Banner>
      ) : null}
      {failed === 'refresh' && loadedAt !== null ? (
        <Banner tone="attention">{t('refresh-failed', { time: timeOf(loadedAt) })}</Banner>
      ) : null}
      {summary === null ? null : (
        <Tiles summary={summary} rows={rows} noRoster={noRoster} now={now} />
      )}
      <Filters
        stateFilter={stateFilter}
        severities={severities}
        onState={setStateFilter}
        onSeverity={toggleSeverity}
      />
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={`${t('error.alerts-title')}. ${t('error.alerts')}`}
          retryLabel={tl('retry')}
          onRetry={() => void loadFirst(false)}
        />
      ) : null}
      {rows.length > 0 ? (
        <AlertsTable rows={rows} now={now} noRoster={noRoster} timeOf={timeOf} />
      ) : null}
      {!loading && failed !== 'first' && rows.length === 0 ? (
        stateFilter === 'live' && severities.size === SEVERITIES.length ? (
          <EmptyState
            icon="shield-check"
            title={t('empty.live-title')}
            body={
              summary?.rulesLastRanAt == null
                ? t('rules-never')
                : t('empty.live', { when: ago(summary.rulesLastRanAt, now) })
            }
          />
        ) : (
          <EmptyState
            icon="shield-check"
            title={t('empty.filtered-title')}
            body={t('empty.filtered')}
          />
        )
      ) : null}
      {loading ? <SkeletonRows label={t('loading')} rows={rows.length > 0 ? 1 : 4} /> : null}
      {failed === 'more' ? <Banner tone="critical">{t('error.alerts')}</Banner> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            {t('load-more')}
          </Button>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <p className="text-sm text-fg-muted">
          {t('list-foot', { count: rows.length })} · {t('masked-note')}
        </p>
      ) : null}
    </div>
  );
}

function Tiles({
  summary,
  rows,
  noRoster,
  now,
}: {
  readonly summary: Summary;
  readonly rows: readonly AlertSummary[];
  readonly noRoster: boolean;
  readonly now: number;
}) {
  const t = useTranslations('security-centre.tiles');
  const { s1, s2, s3, s4 } = summary.live;
  const oldestS1 = rows
    .filter((alert) => alert.severity === 's1' && alert.state === 'open')
    .reduce<string | null>(
      (oldest, alert) => (oldest === null || alert.openedAt < oldest ? alert.openedAt : oldest),
      null,
    );
  const tile = 'flex min-w-0 flex-col gap-1 rounded-lg border p-4';
  return (
    <section aria-label={t('label')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div
        className={`${tile} ${s1 > 0 ? 'border-critical-border bg-critical-bg text-critical-fg' : 'border-line bg-surface'}`}
      >
        <span className="text-sm">{t('s1')}</span>
        <span className="text-2xl font-semibold tabular-nums">{s1}</span>
        <span className="truncate text-sm">
          {s1 > 0 && oldestS1 !== null
            ? t('s1-oldest', { minutes: minutesBetween(oldestS1, now) })
            : t('none')}
        </span>
      </div>
      <div className={`${tile} border-line bg-surface`}>
        <span className="text-sm text-fg-muted">{t('s2')}</span>
        <span className="text-2xl font-semibold tabular-nums">{s2}</span>
        <span className="truncate text-sm text-fg-muted">{s2 > 0 ? t('s2-sub') : t('none')}</span>
      </div>
      <div className={`${tile} border-line bg-surface`}>
        <span className="text-sm text-fg-muted">{t('s34')}</span>
        <span className="text-2xl font-semibold tabular-nums">{s3 + s4}</span>
        <span className="truncate text-sm text-fg-muted">{t('s34-sub')}</span>
      </div>
      <div className={`${tile} border-line bg-surface`}>
        <span className="text-sm text-fg-muted">{t('on-call')}</span>
        <span className="truncate text-lg font-semibold">
          {summary.onCall?.name ?? t('nobody')}
        </span>
        <span className="truncate text-sm text-fg-muted">
          {noRoster || summary.onCall === null ? t('no-roster') : ' '}
        </span>
      </div>
    </section>
  );
}

function Filters({
  stateFilter,
  severities,
  onState,
  onSeverity,
}: {
  readonly stateFilter: StateFilter;
  readonly severities: ReadonlySet<Severity>;
  readonly onState: (value: StateFilter) => void;
  readonly onSeverity: (value: Severity) => void;
}) {
  const t = useTranslations('security-centre');
  const chip = (on: boolean) =>
    `inline-flex min-h-(--mp-size-control) items-center rounded-full border px-4 text-sm font-medium ${
      on
        ? 'border-accent bg-accent text-on-accent'
        : 'border-line-control bg-surface text-fg hover:bg-muted'
    }`;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="me-2 float-start text-sm font-medium text-fg-muted">
          {t('filters.state')}
        </legend>
        {STATE_FILTERS.map((value) => (
          <label
            key={value}
            className={`${chip(stateFilter === value)} cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-focus`}
          >
            <input
              type="radio"
              name="security-state"
              className="sr-only"
              checked={stateFilter === value}
              onChange={() => onState(value)}
            />
            {t(`filters.${value}`)}
          </label>
        ))}
      </fieldset>
      <div
        role="group"
        aria-labelledby="security-severity-label"
        className="flex flex-wrap items-center gap-2"
      >
        <span id="security-severity-label" className="me-2 text-sm font-medium text-fg-muted">
          {t('filters.severity')}
        </span>
        {SEVERITIES.map((severity) => (
          <button
            key={severity}
            type="button"
            aria-pressed={severities.size < SEVERITIES.length && severities.has(severity)}
            onClick={() => onSeverity(severity)}
            className={chip(severities.size < SEVERITIES.length && severities.has(severity))}
          >
            {severity.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

function AlertsTable({
  rows,
  now,
  noRoster,
  timeOf,
}: {
  readonly rows: readonly AlertSummary[];
  readonly now: number;
  readonly noRoster: boolean;
  readonly timeOf: (iso: string) => string;
}) {
  const t = useTranslations('security-centre');
  const ago = useAgo();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('tabs.alerts')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {(['alert', 'severity', 'key', 'events', 'opened', 'state', 'response'] as const).map(
              (col) => (
                <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                  {t(`col.${col}`)}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((alert) => {
            const urgent = alert.severity === 's1' && alert.state === 'open';
            return (
              <tr
                key={alert.id}
                className={`${CARD_TABLE.row} ${urgent ? 'shadow-[inset_3px_0_0_var(--mp-color-status-critical-solid)]' : ''}`}
              >
                <td className={`${CARD_TABLE.cell} lg:min-w-64`}>
                  <a
                    className="font-medium text-link underline"
                    href={`/security/alerts/${alert.id}`}
                  >
                    {alert.title}
                  </a>
                  <div className="font-mono text-xs text-fg-muted">{alert.rule}</div>
                </td>
                <td className={CARD_TABLE.corner}>
                  <SeverityBadge severity={alert.severity} />
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.key')}>
                  <span className="break-all">
                    <span className="text-fg-muted">{t(`key.${alert.keyType}`)}: </span>
                    <span className="font-mono">{alert.keyLabel}</span>
                  </span>
                </td>
                <td className={`${CARD_TABLE.labelled} tabular-nums`} data-label={t('col.events')}>
                  <span>{alert.eventCount}</span>
                </td>
                <td
                  className={`${CARD_TABLE.labelled} whitespace-nowrap`}
                  data-label={t('col.opened')}
                >
                  <span title={timeOf(alert.openedAt)}>{ago(alert.openedAt, now)}</span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.state')}>
                  <span>
                    <StateBadge state={alert.state} />
                  </span>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.response')}>
                  <ResponseText alert={alert} now={now} noRoster={noRoster} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What is happening about an alert now: the S1 clock, who acknowledged, or where it goes. */
export function ResponseText({
  alert,
  now,
  noRoster,
}: {
  readonly alert: AlertSummary;
  readonly now: number;
  readonly noRoster: boolean;
}) {
  const t = useTranslations('security-centre');
  if (alert.state === 'acknowledged') {
    return (
      <span>
        {alert.acknowledgedByName === null
          ? t('response.acknowledged')
          : t('response.acknowledged-by', { name: alert.acknowledgedByName })}
      </span>
    );
  }
  if (alert.state === 'resolved')
    return <span className="text-fg-muted">{t('state.resolved')}</span>;
  if (noRoster && (alert.severity === 's1' || alert.severity === 's2')) {
    return <span className="font-medium text-critical-fg">{t('response.not-sent')}</span>;
  }
  if (alert.severity === 's1') {
    const open = minutesBetween(alert.openedAt, now);
    const left = Math.ceil((Date.parse(alert.openedAt) + S1_RESPONSE_MS - now) / 60_000);
    return left > 0 ? (
      <span className="font-medium tabular-nums">
        {t('response.s1-left', { minutes: open, left })}
      </span>
    ) : (
      <span className="font-medium tabular-nums text-critical-fg">
        {t('response.s1-overdue', { minutes: -left })}
      </span>
    );
  }
  if (alert.severity === 's2') {
    return (
      <span className="text-fg-muted">
        {alert.nextNotifyAt === null ? t('response.s2-sent') : t('response.s2')}
      </span>
    );
  }
  return <span className="text-fg-muted">{t(`response.${alert.severity}`)}</span>;
}
