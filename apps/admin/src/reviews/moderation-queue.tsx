'use client';

import { Banner, Button, CARD_TABLE, EmptyState, LoadError, SkeletonRows } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { labelOr } from './label.ts';
import { shortInstant } from '../shared/format.ts';
import { ReviewDialog } from './review-dialog.tsx';
import { Stars } from './stars.tsx';
import { StatusBadge } from './status-badge.tsx';
import { PAGE_SIZE, TABS, type QueuePage, type ReviewRow, type Tab } from './types.ts';

const ZERO: Readonly<Record<Tab, number>> = { held: 0, reported: 0, actioned: 0 };
const EXCERPT = 140;

const excerpt = (row: ReviewRow): string => {
  const text = [row.title, row.body].filter((part) => part !== null && part !== '').join(' - ');
  return Array.from(text).length > EXCERPT
    ? `${Array.from(text).slice(0, EXCERPT).join('')}…`
    : text;
};

/**
 * The buyer-review moderation queue: held, reported and actioned reviews, newest first and paged
 * by cursor. A review opens in a dialog where it is published, hidden, restored or removed.
 */
export function ModerationQueue({
  canModerate,
  canRemove,
  csrfToken,
}: {
  readonly canModerate: boolean;
  readonly canRemove: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('reviews-moderation');
  const locale = useLocale();
  const [tab, setTab] = useState<Tab>('held');
  const [rows, setRows] = useState<readonly ReviewRow[]>([]);
  const [counts, setCounts] = useState<Readonly<Record<Tab, number>>>(ZERO);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<'first' | 'more' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailed(null);
      // A new first page replaces the list at once: another tab's rows never show under this one.
      if (after === null) {
        setRows([]);
        setNext(null);
      }
      const query = new URLSearchParams({ tab, limit: String(PAGE_SIZE) });
      if (after !== null) query.set('cursor', after);
      const result = await callApi<QueuePage>(
        'GET',
        `reviews/admin/moderation?${query.toString()}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailed(after === null ? 'first' : 'more');
        return;
      }
      setCounts({ ...ZERO, ...result.body.counts });
      setRows((current) => {
        if (after === null) return result.body.items;
        const known = new Set(current.map((row) => row.id));
        return [...current, ...result.body.items.filter((row) => !known.has(row.id))];
      });
      setNext(result.body.nextCursor);
    },
    [tab],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <div role="group" aria-label={t('tabs')} className="flex flex-wrap gap-2">
        {TABS.map((name) => {
          const on = name === tab;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              onClick={() => setTab(name)}
              className={`inline-flex min-h-(--mp-size-control) items-center gap-2 rounded-full border px-4 text-sm font-medium ${
                on
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-line-control bg-surface text-fg hover:bg-muted'
              }`}
            >
              {t(`tab.${name}`)}
              <span className="tabular-nums">{counts[name]}</span>
            </button>
          );
        })}
      </div>
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.unavailable')}
          retryLabel={t('retry')}
          onRetry={() => void load(null)}
        />
      ) : null}
      {rows.length > 0 ? (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                {(['review', 'rating', 'status', 'flags', 'submitted'] as const).map((col) => (
                  <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(`col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {rows.map((row) => (
                <tr key={row.id} className={CARD_TABLE.row}>
                  <td className={`${CARD_TABLE.cell} lg:max-w-md`}>
                    <button
                      type="button"
                      className="break-words text-start font-medium text-link underline"
                      onClick={() => setOpen(row.id)}
                    >
                      {excerpt(row) === '' ? t('no-text') : excerpt(row)}
                    </button>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.rating')}>
                    <Stars rating={row.rating} />
                  </td>
                  <td className={CARD_TABLE.corner}>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.flags')}>
                    <span>
                      {[
                        ...row.signalCodes.map((code) => labelOr(t, `signal.${code}`, code)),
                        ...(row.openReports > 0
                          ? [t('open-reports', { count: row.openReports })]
                          : []),
                      ].join(', ') || '-'}
                    </span>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.submitted')}>
                    <span>{shortInstant(row.createdAt, locale)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!loading && failed === null && rows.length === 0 ? (
        <EmptyState icon="shield-check" title={t(`empty.${tab}`)} />
      ) : null}
      {loading ? <SkeletonRows label={t('loading')} rows={rows.length > 0 ? 1 : 3} /> : null}
      {failed === 'more' ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {t('more')}
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-fg-muted">{t('footnote')}</p>
      <ReviewDialog
        reviewId={open}
        canModerate={canModerate}
        canRemove={canRemove}
        csrfToken={csrfToken}
        onClose={() => setOpen(null)}
        onChanged={() => void load(null)}
      />
    </div>
  );
}
