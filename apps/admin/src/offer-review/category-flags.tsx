'use client';

import { Banner, Button, EmptyState, Select, Switch } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import {
  CATEGORY_FLAGS_PATH,
  categoryFlagPath,
  flaggedCategoriesOf,
  type CategoryChoice,
  type CategoryFlagId,
  type FlaggedCategory,
} from './category-flags-types.ts';
import { flagErrorKey } from './flag-errors.ts';
import { ReasonDialog, type ReasonResult } from './reason-dialog.tsx';

const FLAGS = ['always-review', 'review-stop'] as const;
const on = (row: FlaggedCategory, flag: CategoryFlagId): boolean =>
  flag === 'always-review' ? row.alwaysReview : row.reviewStop;
const changedAt = (row: FlaggedCategory): string | null =>
  [row.alwaysReviewChangedAt, row.reviewStopChangedAt]
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

/**
 * Settings › Catalogue › Offer review › Categories: the platform categories whose Offers always
 * wait for a person ("Always review", R7) or whose new Offers all wait (Review stop, R0), both
 * also for their sub-categories. Only categories with a flag are listed; "Add a category" picks
 * another to switch. Every change asks for a reason of 1 to 500 characters and a two-step code.
 * The list stays under 50 rows, so it is a plain table.
 */
export function CategoryFlags({
  initial,
  choices,
  canAlways,
  canStop,
  csrfToken,
  zone,
}: {
  readonly initial: readonly FlaggedCategory[];
  /** The categories the admin may add, named by their path. */
  readonly choices: readonly CategoryChoice[];
  readonly canAlways: boolean;
  readonly canStop: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('offer-review.categories');
  const tf = useTranslations('offer-review.flag-error');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [rows, setRows] = useState<readonly FlaggedCategory[]>(initial);
  const [added, setAdded] = useState<readonly string[]>([]);
  const [pick, setPick] = useState('');
  const [asking, setAsking] = useState<{ id: string; flag: CategoryFlagId } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const labelOf = useMemo(() => new Map(choices.map((c) => [c.id, c.label])), [choices]);
  // A category added in place has no flags yet: version 0 and both switches off.
  const shown: readonly FlaggedCategory[] = [
    ...rows,
    ...added
      .filter((id) => !rows.some((row) => row.categoryId === id))
      .map((id) => ({
        categoryId: id,
        alwaysReview: false,
        reviewStop: false,
        alwaysReviewChangedAt: null,
        reviewStopChangedAt: null,
        version: 0,
      })),
  ];
  const addable = choices.filter((c) => !shown.some((row) => row.categoryId === c.id));
  const name = (id: string) => labelOf.get(id) ?? t('unknown-category');

  async function reload() {
    const result = await callApi<unknown>('GET', CATEGORY_FLAGS_PATH);
    if (result.ok) {
      const next = flaggedCategoriesOf(result.body);
      if (next !== null) {
        setRows(next);
        setAdded((ids) => ids.filter((id) => !next.some((row) => row.categoryId === id)));
      }
    }
  }

  async function change(
    id: string,
    flag: CategoryFlagId,
    value: boolean,
    reason: string,
  ): Promise<ReasonResult> {
    const row = shown.find((each) => each.categoryId === id);
    if (row === undefined) return { kind: 'failed', message: tf('unavailable') };
    const result = await guarded<{ on: boolean; changed: boolean; version: number }>(
      'PUT',
      categoryFlagPath(id, flag),
      { on: value, reason, expectedVersion: row.version },
      csrfToken,
    );
    if (result.ok) {
      const now = new Date().toISOString();
      const next: FlaggedCategory = {
        ...row,
        ...(flag === 'always-review'
          ? { alwaysReview: result.body.on, alwaysReviewChangedAt: now }
          : { reviewStop: result.body.on, reviewStopChangedAt: now }),
        version: result.body.version,
      };
      setRows((list) =>
        list.some((each) => each.categoryId === id)
          ? list.map((each) => (each.categoryId === id ? next : each))
          : [...list, next],
      );
      setNotice(t(`done.${flag}.${result.body.on ? 'on' : 'off'}`, { name: name(id) }));
      setStale(false);
      return { kind: 'done' };
    }
    if (isStepUpCancelled(result)) return { kind: 'cancelled' };
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return { kind: 'cancelled' };
    }
    const key = flagErrorKey(result.failure);
    if (key === 'stale') {
      await reload();
      setStale(true);
      setAsking(null);
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', message: tf(key) };
  }

  const askRow = asking === null ? null : shown.find((row) => row.categoryId === asking.id);
  return (
    <div className="flex flex-col gap-4">
      {shown.length === 0 ? (
        <EmptyState size="compact" icon="search" title={t('empty.title')} body={t('empty.body')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-start">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="border-b border-line bg-muted text-sm">
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.category')}
                </th>
                {FLAGS.map((flag) => (
                  <th key={flag} scope="col" className="px-4 py-2 text-start font-medium">
                    {t(`col.${flag}`)}
                  </th>
                ))}
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.changed')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const when = changedAt(row);
                return (
                  <tr key={row.categoryId} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-3 text-start font-medium wrap-anywhere">
                      {name(row.categoryId)}
                    </th>
                    {FLAGS.map((flag) => {
                      const allowed = flag === 'always-review' ? canAlways : canStop;
                      return (
                        <td key={flag} className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Switch
                              aria-label={t(`switch.${flag}`, { name: name(row.categoryId) })}
                              checked={on(row, flag)}
                              disabled={!allowed || asking !== null}
                              onCheckedChange={() => {
                                setNotice(null);
                                setAsking({ id: row.categoryId, flag });
                              }}
                            />
                            <span className="text-sm">{t(on(row, flag) ? 'on' : 'off')}</span>
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-sm text-fg-muted">
                      {when === null ? '-' : formatInstantInZone(when, locale, zone)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canAlways || canStop ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pick === '') return;
            setAdded((ids) => [...ids, pick]);
            setPick('');
          }}
        >
          <div className="w-full max-w-md">
            <Select
              name="category"
              label={t('add.label')}
              placeholder={t('add.placeholder')}
              value={pick}
              options={addable.map((c) => ({ value: c.id, label: c.label }))}
              onChange={(event) => setPick(event.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={pick === ''}>
            {t('add.button')}
          </Button>
        </form>
      ) : (
        <p className="m-0 text-sm text-fg-muted">{t('read-only')}</p>
      )}
      <div role="status" aria-live="polite">
        {notice === null ? null : <p className="m-0 font-medium">{notice}</p>}
        {stale ? <Banner tone="attention">{t('stale')}</Banner> : null}
      </div>
      {asking === null || askRow === null || askRow === undefined ? null : (
        <ReasonDialog
          title={t(`dialog.${asking.flag}.${on(askRow, asking.flag) ? 'off' : 'on'}.title`, {
            name: name(asking.id),
          })}
          intro={
            <>
              <p className="m-0">
                {t(`dialog.${asking.flag}.${on(askRow, asking.flag) ? 'off' : 'on'}.body`, {
                  name: name(asking.id),
                })}
              </p>
              <p className="mt-2 mb-0 font-medium">{t('dialog.subcategories')}</p>
            </>
          }
          confirm={t(`dialog.${asking.flag}.${on(askRow, asking.flag) ? 'off' : 'on'}.confirm`)}
          confirmVariant={
            asking.flag === 'review-stop' && !on(askRow, asking.flag)
              ? 'destructive-solid'
              : 'primary'
          }
          onClose={() => setAsking(null)}
          onConfirm={(reason) => change(asking.id, asking.flag, !on(askRow, asking.flag), reason)}
        />
      )}
    </div>
  );
}
