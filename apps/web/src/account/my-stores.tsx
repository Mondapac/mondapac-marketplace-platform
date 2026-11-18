'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatInstantDay } from '../format/instant.ts';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import { storeImageSrc } from '../storefront/real-sellers.ts';
import { AccountFrame } from './account-area.tsx';
import {
  followStore,
  readFollowedStores,
  unfollowStore,
  type FollowedStore,
} from './follow-api.ts';

// "My stores" (customers management phase 3; Reza's spec 4): the stores the buyer follows, newest
// first, 50 to a page with "Load more". Unfollow is one tap; the row then offers Undo for 5
// seconds (Undo follows the store again) and leaves the list. Each row carries the store's public
// name and logo; a store that is not public now shows greyed with no link and still unfollows. This is the buyer's own
// list of at most the account's follow limit, paged by the API: a storefront account page, not a
// panel super list (rule 14 is about the admin and seller panels).

/** How long Undo stays on a row. */
export const UNDO_MS = 5000;

type Phase = 'loading' | 'ready' | 'failed' | 'throttled';
type RowState = 'following' | 'unfollowed' | 'busy' | 'failed' | 'refused-limit' | 'refused-gone';

/** A copy of the row states without one seller. */
const omit = (
  states: Readonly<Record<string, RowState>>,
  sellerId: string,
): Readonly<Record<string, RowState>> =>
  Object.fromEntries(Object.entries(states).filter(([key]) => key !== sellerId));

export function MyStores() {
  const t = useTranslations('account.stores');
  const title = useTranslations('account.titles')('stores');
  const { live, customer, setLoginOpen } = useStore();
  const [rows, setRows] = useState<readonly FollowedStore[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(live ? 'loading' : 'ready');
  const [retryAfter, setRetryAfter] = useState<number | undefined>();
  const [more, setMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [state, setState] = useState<Readonly<Record<string, RowState>>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [announce, setAnnounce] = useState('');
  const rowsRef = useRef<readonly FollowedStore[]>([]);
  rowsRef.current = rows;
  // Where focus goes after a row leaves: the next row's button, else the heading.
  const [refocus, setRefocus] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    const read = await readFollowedStores(cursor);
    if (read.kind === 'ok') {
      setRows((current) =>
        cursor === null ? read.value.items : [...current, ...read.value.items],
      );
      setTotal(read.value.total);
      setNext(read.value.nextCursor);
      return 'ok' as const;
    }
    if (read.kind === 'throttled') setRetryAfter(read.retryAfterSeconds);
    return read.kind === 'throttled' ? ('throttled' as const) : ('failed' as const);
  }, []);

  const first = useCallback(async () => {
    setPhase('loading');
    const outcome = await load(null);
    setPhase(outcome === 'ok' ? 'ready' : outcome);
  }, [load]);

  useEffect(() => {
    if (live && customer !== null) void first();
  }, [live, customer, first]);

  useEffect(() => {
    const open = timers.current;
    return () => open.forEach((timer) => clearTimeout(timer));
  }, []);

  const loadMore = async () => {
    setMore(true);
    setMoreFailed(false);
    const outcome = await load(next);
    setMore(false);
    setMoreFailed(outcome !== 'ok');
  };

  useEffect(() => {
    if (refocus === null) return;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost) {
      const target =
        refocus === ''
          ? document.getElementById('stores-head')
          : document.querySelector<HTMLElement>(`[data-store-row="${refocus}"] button`);
      target?.focus({ preventScroll: true });
    }
    setRefocus(null);
  }, [refocus, rows]);

  const drop = (sellerId: string) => {
    timers.current.delete(sellerId);
    const at = rowsRef.current.findIndex((row) => row.sellerId === sellerId);
    const neighbour = rowsRef.current[at + 1] ?? rowsRef.current[at - 1];
    setRefocus(neighbour?.sellerId ?? '');
    setRows((current) => current.filter((row) => row.sellerId !== sellerId));
    setTotal((count) => Math.max(0, count - 1));
    setState((current) => omit(current, sellerId));
  };

  const unfollow = async (row: FollowedStore, label: string) => {
    setState((current) => ({ ...current, [row.sellerId]: 'busy' }));
    const result = await unfollowStore(row.sellerId);
    if (result.kind === 'signed-out') {
      setState((current) => omit(current, row.sellerId));
      setLoginOpen(true);
      return;
    }
    if (result.kind !== 'ok') {
      setState((current) => ({ ...current, [row.sellerId]: 'failed' }));
      return;
    }
    setAnnounce(t('unfollowed-announce', { store: label }));
    setState((current) => ({ ...current, [row.sellerId]: 'unfollowed' }));
    timers.current.set(
      row.sellerId,
      setTimeout(() => drop(row.sellerId), UNDO_MS),
    );
  };

  const undo = async (row: FollowedStore, label: string) => {
    clearTimeout(timers.current.get(row.sellerId));
    timers.current.delete(row.sellerId);
    setState((current) => ({ ...current, [row.sellerId]: 'busy' }));
    const result = await followStore(row.sellerId);
    if (result.kind === 'ok' && result.value.following) {
      setAnnounce(t('following-announce', { store: label }));
      setState((current) => omit(current, row.sellerId));
      return;
    }
    // The store cannot be followed again (the limit, or not public now): say why; the row leaves.
    const limit = result.kind === 'invalid' && result.code === 'engagement.follow-limit';
    setState((current) => ({
      ...current,
      [row.sellerId]: limit ? 'refused-limit' : 'refused-gone',
    }));
    timers.current.set(
      row.sellerId,
      setTimeout(() => drop(row.sellerId), UNDO_MS),
    );
  };

  return (
    <AccountFrame title={title}>
      <section className="ac-card" aria-labelledby="stores-head">
        <h2 id="stores-head" tabIndex={-1}>
          {t('heading', { count: total })}
        </h2>
        <p className="ac-sub">{t('privacy')}</p>
        <div className="ac-live" role="status" aria-live="polite">
          {announce}
        </div>
        {phase === 'loading' ? (
          <div role="status" aria-busy="true">
            <span className="fl-sr">{t('loading')}</span>
            {[0, 1, 2].map((n) => (
              <div className="ms-row ms-skel" key={n} aria-hidden="true" />
            ))}
          </div>
        ) : phase === 'failed' || phase === 'throttled' ? (
          <div className="ac-note ac-warn" role="alert">
            <span>
              {phase === 'throttled' && retryAfter !== undefined
                ? t('try-again-in', { minutes: Math.max(1, Math.ceil(retryAfter / 60)) })
                : t('error')}
            </span>
            <button className="lnk" type="button" onClick={() => void first()}>
              {t('retry')}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div>
            <p>{t('empty')}</p>
            <Link className="btn ghost" href="/sellers">
              {t('browse')}
            </Link>
          </div>
        ) : (
          <>
            <ul className="ms-list">
              {rows.map((row) => (
                <StoreRow
                  key={row.sellerId}
                  row={row}
                  state={state[row.sellerId] ?? 'following'}
                  onUnfollow={(label) => void unfollow(row, label)}
                  onUndo={(label) => void undo(row, label)}
                />
              ))}
            </ul>
            {next === null ? null : (
              <div>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={more}
                  onClick={() => void loadMore()}
                >
                  {t('load-more')}
                </button>
                {moreFailed ? (
                  <p className="fl-err" role="alert">
                    {t('error')}
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </section>
    </AccountFrame>
  );
}

function StoreRow({
  row,
  state,
  onUnfollow,
  onUndo,
}: {
  readonly row: FollowedStore;
  readonly state: RowState;
  readonly onUnfollow: (label: string) => void;
  readonly onUndo: (label: string) => void;
}) {
  const t = useTranslations('account.stores');
  const locale = useLocale();
  const hidden = row.slug === null;
  const label = hidden ? t('unavailable') : (row.name ?? row.slug ?? '');
  const logo =
    row.slug !== null && row.logoId !== null
      ? { src: storeImageSrc(row.slug, row.logoId, 'small'), width: 64, height: 64 }
      : undefined;
  const since = formatInstantDay(row.followedAt, locale);
  return (
    <li className={hidden ? 'ms-row ms-off' : 'ms-row'} data-store-row={row.sellerId}>
      <SellerLogo logo={undefined} image={logo} />
      <div className="ms-id">
        {hidden || row.slug === null ? (
          <span className="ms-name">{label}</span>
        ) : (
          <Link className="ms-name" href={`/s/${row.slug}`}>
            {label}
          </Link>
        )}
        <small>{t('since', { date: since })}</small>
      </div>
      {state === 'refused-limit' || state === 'refused-gone' ? (
        <p className="ms-undo" role="alert">
          {state === 'refused-limit' ? t('undo-limit') : t('undo-gone')}
        </p>
      ) : state === 'unfollowed' ? (
        <p className="ms-undo">
          {t('unfollowed')}{' '}
          <button
            className="lnk"
            type="button"
            aria-label={t('undo-label', { store: label })}
            onClick={() => onUndo(label)}
          >
            {t('undo')}
          </button>
        </p>
      ) : (
        <div className="ms-act">
          <button
            className="btn fl-btn on"
            type="button"
            aria-pressed="true"
            disabled={state === 'busy'}
            onClick={() => onUnfollow(label)}
          >
            {t('following')}
            <span className="fl-sr"> {label}</span>
          </button>
          {state === 'failed' ? (
            <small className="fl-err" role="alert">
              {t('row-error')}
            </small>
          ) : null}
        </div>
      )}
    </li>
  );
}
