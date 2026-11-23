'use client';

import { Banner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../sales/cursor-paging.ts';
import { AlertList } from './alert-list/alert-list.tsx';
import type { View } from './alert-list/list-types.ts';
import { useAgo, useNow, usePoll } from './parts.tsx';
import {
  minutesBetween,
  PAGE_POLL_MS,
  rulesStale,
  S1_RESPONSE_MS,
  type Severity,
  type Summary,
} from './types.ts';

/**
 * The Alerts tab: the live counts and the banners that say the system is not working (no roster,
 * rules stopped) above the alert list (a super list, list 37). The counts and banners read again
 * every 30 s while the tab is visible (F4), like the list itself; a read that fails keeps the last
 * ones. A rise in live critical alerts is announced to screen readers.
 */
export function AlertsList({
  zone,
  paging,
  accountId,
  marketId,
  csrfToken = '',
  initialView,
  initialSeverity,
}: {
  readonly zone: string;
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken?: string;
  /** From the address, so a link (the badge, a bookmark) opens the right view. */
  readonly initialView?: View;
  readonly initialSeverity?: Severity;
}) {
  const t = useTranslations('security-centre');
  const ago = useAgo();
  const now = useNow();
  const [summary, setSummary] = useState<Summary | null>(null);
  // The oldest open critical alert, for the first tile's clock.
  const [oldestS1, setOldestS1] = useState<string | null>(null);
  const [rosterSet, setRosterSet] = useState<boolean | null>(null);
  const [announce, setAnnounce] = useState('');
  const lastCritical = useRef<number | null>(null);

  /** A live region reads a change only: clear it first, so a second alert is read too. */
  const say = (text: string) => {
    setAnnounce('');
    setTimeout(() => setAnnounce(text), 50);
  };

  const readSummary = useCallback(async () => {
    const [counts, onCall, oldest] = await Promise.all([
      callApi<Summary>('GET', 'security/admin/summary'),
      callApi<{ readonly configured: boolean }>('GET', 'security/admin/on-call'),
      callApi<{ readonly items: readonly { readonly openedAt: string }[] }>(
        'GET',
        'security/admin/alerts/list?view=open&severity=s1&sort=opened&direction=asc&paging=prev-next&page=1&pageSize=1',
      ),
    ]);
    if (counts.ok) {
      const critical = counts.body.live.s1;
      if (lastCritical.current !== null && critical > lastCritical.current) {
        say(t('badge.announce'));
      }
      lastCritical.current = critical;
      setSummary(counts.body);
    } else if (counts.failure.status === 401) {
      window.location.assign('/session-ended');
    }
    if (onCall.ok) setRosterSet(onCall.body.configured);
    if (oldest.ok) setOldestS1(oldest.body.items[0]?.openedAt ?? null);
  }, [t]);

  useEffect(() => {
    void readSummary();
  }, [readSummary]);
  usePoll(() => void readSummary(), PAGE_POLL_MS);

  const stale = summary !== null && rulesStale(summary.rulesLastRanAt, now);
  const staleMinutes =
    summary?.rulesLastRanAt == null ? null : minutesBetween(summary.rulesLastRanAt, now);
  const noRoster = rosterSet === false;

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
      {summary === null ? null : (
        <Tiles summary={summary} oldestS1={oldestS1} noRoster={noRoster} now={now} />
      )}
      <AlertList
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        zone={zone}
        now={now}
        noRoster={noRoster}
        csrfToken={csrfToken}
        {...(initialView === undefined ? {} : { initialView })}
        {...(initialSeverity === undefined ? {} : { initialSeverity })}
      />
    </div>
  );
}

function Tiles({
  summary,
  oldestS1,
  noRoster,
  now,
}: {
  readonly summary: Summary;
  readonly oldestS1: string | null;
  readonly noRoster: boolean;
  readonly now: number;
}) {
  const t = useTranslations('security-centre.tiles');
  const { s1, s2, s3, s4 } = summary.live;
  const tile = 'flex min-w-0 flex-col gap-1 rounded-lg border p-4';
  return (
    <section aria-label={t('label')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div
        className={`${tile} ${s1 > 0 ? 'border-critical-border bg-critical-bg text-critical-fg' : 'border-line bg-surface'}`}
      >
        <span className="text-sm">{t('s1')}</span>
        <span className="text-2xl font-semibold tabular-nums">{s1}</span>
        <span className="text-sm">
          {s1 > 0 && oldestS1 !== null
            ? s1Clock(minutesBetween(oldestS1, now), (key, values) => t(key, values))
            : t('none')}
        </span>
      </div>
      <div className={`${tile} border-line bg-surface`}>
        <span className="text-sm text-fg-muted">{t('s2')}</span>
        <span className="text-2xl font-semibold tabular-nums">{s2}</span>
        <span className="text-sm text-fg-muted">{s2 > 0 ? t('s2-sub') : t('none')}</span>
      </div>
      <div className={`${tile} border-line bg-surface`}>
        <span className="text-sm text-fg-muted">{t('s34')}</span>
        <span className="text-2xl font-semibold tabular-nums">{s3 + s4}</span>
        <span className="text-sm text-fg-muted">{t('s34-sub')}</span>
      </div>
      {noRoster || summary.onCall === null ? (
        // Nobody is told about anything: this tile is an alarm, not a fact (Reza S12).
        <div className={`${tile} border-critical-border bg-critical-bg text-critical-fg`}>
          <span className="text-sm">{t('on-call')}</span>
          <span className="text-lg font-semibold">{t('nobody')}</span>
          <span className="text-sm">{t('no-roster')}</span>
        </div>
      ) : (
        <div className={`${tile} border-line bg-surface`}>
          <span className="text-sm text-fg-muted">{t('on-call')}</span>
          <span className="truncate text-lg font-semibold">{summary.onCall.name}</span>
        </div>
      )}
    </section>
  );
}

/** "Open 8 min · 7 min left" or "Overdue by 3 min" for the oldest open critical alert. */
function s1Clock(
  minutes: number,
  t: (key: 's1-oldest' | 's1-overdue', values: Record<string, number>) => string,
): string {
  const left = Math.floor(S1_RESPONSE_MS / 60_000) - minutes;
  return left >= 0 ? t('s1-oldest', { minutes, left }) : t('s1-overdue', { minutes: -left });
}
