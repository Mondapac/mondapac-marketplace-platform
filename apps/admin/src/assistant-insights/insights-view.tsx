'use client';

import { Badge, Banner, Button, LoadError, TableSkeleton } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { dateFormat, numberFormat } from '../shared/intl.ts';
import { averageCostUsd, hasMoreGroups, rangeQuery } from './insights-math.ts';
import {
  DEFAULT_RANGE,
  INSIGHTS_PAGE_SIZE,
  INSIGHTS_PATH,
  RANGES,
  type Insights,
  type Range,
  type UnansweredRow,
} from './types.ts';
import { UnansweredList } from './unanswered-list.tsx';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly answer: Insights;
      readonly rows: readonly UnansweredRow[];
      /** Another read is running: the old figures stay on show, dimmed. */
      readonly busy: boolean;
      /** The last read failed or stopped short; what is shown is from an earlier or partial read. */
      readonly problem: 'refresh' | 'partial' | null;
    };

/**
 * Settings > Shopping assistant > Insights: how many conversations and what they cost per day, how
 * buyers rated the answers, support hand-offs, and the questions the assistant could not answer
 * as a super list. The day range is the page's own control (it changes what is read), not a
 * filter of the list. The Market's calendar day comes from the first answer.
 */
export function AssistantInsights({
  paging,
  zone,
  accountId,
  marketId,
  csrfToken,
}: {
  readonly paging: 'pages' | 'prev-next';
  readonly zone: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('assistant-insights');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const today = useRef<string | null>(null);
  const latest = useRef(0);

  const read = useCallback(async (asked: Range) => {
    const ticket = ++latest.current;
    // A later read keeps the figures and the list (with its selection) on show, dimmed.
    setLoad((current) =>
      current.kind === 'ready' ? { ...current, busy: true } : { kind: 'loading' },
    );
    const first = await callApi<Insights>(
      'GET',
      today.current === null
        ? INSIGHTS_PATH +
            (asked === DEFAULT_RANGE
              ? `?page=1&pageSize=${INSIGHTS_PAGE_SIZE}`
              : '?page=1&pageSize=1')
        : `${INSIGHTS_PATH}?${rangeQuery(asked, today.current, 1)}`,
    );
    if (ticket !== latest.current) return;
    if (!first.ok) {
      if (first.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoad((current) =>
        current.kind === 'ready'
          ? { ...current, busy: false, problem: 'refresh' }
          : { kind: 'failed' },
      );
      return;
    }
    // The first read without dates tells the Market's own "today"; a range other than the default
    // is then asked again with dates.
    if (today.current === null) {
      today.current = first.body.to;
      if (asked !== DEFAULT_RANGE) {
        void read(asked);
        return;
      }
    }
    let answer = first.body;
    let rows = answer.unanswered.rows;
    let problem: 'partial' | null = null;
    // The route keeps 200 groups: a second page of 100 holds the rest.
    if (hasMoreGroups(answer)) {
      const more = await callApi<Insights>(
        'GET',
        `${INSIGHTS_PATH}?${rangeQuery(asked, today.current, answer.unanswered.page + 1)}`,
      );
      if (ticket !== latest.current) return;
      if (more.ok) {
        rows = [...rows, ...more.body.unanswered.rows];
      } else {
        // The first hundred groups are real: show them and say the rest is missing.
        problem = 'partial';
      }
      answer = { ...answer, unanswered: { ...answer.unanswered, rows } };
    }
    setLoad({ kind: 'ready', answer, rows, problem, busy: false });
  }, []);

  useEffect(() => {
    void read(range);
  }, [read, range]);

  const number = (value: number, options: Intl.NumberFormatOptions = {}) =>
    numberFormat(locale, options).format(value);
  const usd = (value: number) =>
    number(value, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 });
  const percent = (value: number) => number(value, { style: 'percent', maximumFractionDigits: 0 });

  // Refresh also asks the Market's day again, so a tab left open past midnight moves on.
  const refresh = () => {
    today.current = null;
    void read(range);
  };
  const ranges = (
    <div role="group" aria-label={t('range.label')} className="flex flex-wrap items-center gap-2">
      {RANGES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={value === range}
          onClick={() => setRange(value)}
          className={`inline-flex min-h-(--mp-size-control) items-center rounded-full border px-4 text-sm font-medium ${
            value === range
              ? 'border-accent bg-accent text-on-accent'
              : 'border-line-control bg-surface text-fg hover:bg-muted'
          }`}
        >
          {t('range.days', { count: Number(value) })}
        </button>
      ))}
      <Button variant="secondary" onClick={refresh}>
        {t('refresh')}
      </Button>
    </div>
  );

  if (load.kind === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        {ranges}
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={refresh}
        />
      </div>
    );
  }
  if (load.kind === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        {ranges}
        <TableSkeleton
          label={t('loading')}
          slowLabel={tl('slow')}
          rows={6}
          columns={[
            { header: t('list.col.query'), kind: 'title' },
            { header: t('list.col.count'), kind: 'number' },
            { header: t('list.col.last'), kind: 'date' },
          ]}
        />
      </div>
    );
  }

  const { answer, rows, busy, problem } = load;
  const average = averageCostUsd(answer.totals);
  const feedbackTotal = answer.feedback.up + answer.feedback.down;
  const peak = Math.max(1, ...answer.days.map((day) => day.conversations));
  const dayLabel = (day: string) =>
    dateFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(`${day}T00:00:00Z`),
    );
  const fromDay = answer.from;
  const toDay = answer.to;

  return (
    <div className={`flex flex-col gap-6 ${busy ? 'opacity-60' : ''}`} aria-busy={busy}>
      {problem === null ? null : (
        <Banner tone="attention">
          {problem === 'partial' ? t('error.partial') : t('error.refresh')}
        </Banner>
      )}
      <div className="flex flex-col gap-2">
        {ranges}
        <p className="text-sm text-fg-muted">
          {t('range.note', { from: dayLabel(fromDay), to: dayLabel(toDay) })}
        </p>
      </div>

      <section aria-labelledby="ai-summary" className="flex flex-col gap-3">
        <h2 id="ai-summary" className="text-lg font-semibold">
          {t('summary.title')}
        </h2>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t('summary.conversations'), number(answer.totals.conversations)],
            [t('summary.spend'), usd(answer.totals.spendMicroUsd / 1_000_000)],
            [t('summary.average'), average === null ? t('summary.none') : usd(average)],
            [t('summary.handoffs'), number(answer.handoffs)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-surface p-4">
              <dt className="text-sm text-fg-muted">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="ai-daily" className="flex flex-col gap-3">
        <h2 id="ai-daily" className="text-lg font-semibold">
          {t('daily.title')}
        </h2>
        {answer.totals.conversations === 0 ? (
          <Banner tone="info">{t('daily.empty')}</Banner>
        ) : (
          <>
            <div
              role="img"
              aria-label={t('daily.chart-label', {
                days: answer.days.length,
                total: number(answer.totals.conversations),
              })}
              className="flex h-40 items-end gap-px rounded-lg border border-line bg-surface p-3"
            >
              {answer.days.map((day) => (
                <div
                  key={day.day}
                  title={t('daily.bar', {
                    day: dayLabel(day.day),
                    count: day.conversations,
                    spend: usd(day.spendMicroUsd / 1_000_000),
                  })}
                  className="min-w-px flex-1 rounded-t-sm bg-accent"
                  style={{ height: `${Math.max(2, (day.conversations / peak) * 100)}%` }}
                />
              ))}
            </div>
            <p className="flex justify-between gap-3 text-sm text-fg-muted">
              <span>{dayLabel(answer.days[0]?.day ?? fromDay)}</span>
              <span>{t('daily.peak', { count: number(peak) })}</span>
              <span>{dayLabel(answer.days.at(-1)?.day ?? toDay)}</span>
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">{t('daily.table-toggle')}</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-80 text-start">
                  <caption className="sr-only">{t('daily.title')}</caption>
                  <thead>
                    <tr className="border-b border-line text-fg-muted">
                      <th scope="col" className="py-2 text-start font-medium">
                        {t('daily.col.day')}
                      </th>
                      <th scope="col" className="py-2 text-end font-medium">
                        {t('daily.col.conversations')}
                      </th>
                      <th scope="col" className="py-2 text-end font-medium">
                        {t('daily.col.spend')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {answer.days.map((day) => (
                      <tr key={day.day} className="border-b border-line">
                        <th scope="row" className="py-2 text-start font-normal">
                          {dayLabel(day.day)}
                        </th>
                        <td className="py-2 text-end tabular-nums">{number(day.conversations)}</td>
                        <td className="py-2 text-end tabular-nums">
                          {usd(day.spendMicroUsd / 1_000_000)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>

      <section aria-labelledby="ai-feedback" className="flex flex-col gap-3">
        <h2 id="ai-feedback" className="text-lg font-semibold">
          {t('feedback.title')}
        </h2>
        {feedbackTotal === 0 || answer.feedback.upShare === null ? (
          <p className="text-fg-muted">{t('feedback.empty')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p>
              {t('feedback.share', {
                share: percent(answer.feedback.upShare),
                up: number(answer.feedback.up),
                down: number(answer.feedback.down),
              })}
            </p>
            <ul className="flex flex-wrap gap-2">
              {(['wrong', 'not-found', 'other'] as const).map((reason) => (
                <li key={reason}>
                  <Badge tone="neutral">
                    {t('feedback.reason', {
                      reason: t(`feedback.reasons.${reason}`),
                      count: answer.feedback.reasons[reason] ?? 0,
                    })}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="ai-unanswered" className="flex flex-col gap-3">
        <h2 id="ai-unanswered" className="text-lg font-semibold">
          {t('list.title')}
        </h2>
        <UnansweredList
          rows={rows}
          loading={busy}
          truncated={answer.unanswered.truncated}
          paging={paging}
          zone={zone}
          accountId={accountId}
          marketId={marketId}
          csrfToken={csrfToken}
          fromDay={fromDay}
          toDay={toDay}
        />
      </section>
    </div>
  );
}
