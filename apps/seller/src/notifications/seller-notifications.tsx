'use client';

import {
  createChime,
  Icon,
  laterNotice,
  NotificationBell,
  NotificationDrawer,
  SELLER_POLL_MILLISECONDS,
  shouldRing,
  type NoticeFilter,
  type NoticeItem,
  type NoticeListState,
} from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { callApi } from '../api/client.ts';
import {
  ORDER_PAID,
  RINGING_KINDS,
  type Notice,
  type NoticePage,
  type UnreadNotices,
} from './types.ts';

const BASE = 'notifications/seller/notices';
/** Shared by the panel's tabs in this browser: the newest notice already rung, and the switch. */
const HEARD_KEY = 'mp.seller.notices.heard';
const SOUND_KEY = 'mp.seller.notices.sound';
/** Tabs tell each other a notice rang, so their badges follow at once (and do not ring again). */
const CHANNEL = 'mp.seller.notices';
const LOCK = 'mp.seller.notices.sound';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the sound may then ring once per tab, which is still a single signal.
  }
}

/** Runs `task` in one tab at a time where the browser has Web Locks; elsewhere just runs it. */
async function exclusive(task: () => void): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) {
    task();
    return;
  }
  await locks.request(LOCK, () => task());
}

/**
 * The seller topbar's bell (in-app notifications package 2): the unread badge, polled every
 * 30 s while the tab is visible (paused while hidden, asked again on return), the notices drawer
 * with its Unread / Read / All tabs, and the new-order sound. The sound rings once per new order
 * burst, in one tab, never on notices already waiting when the panel opens, and never as the only
 * signal: the badge changes and a polite live region says so.
 */
export function SellerNotifications({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('notifications');
  const format = useFormatter();
  const router = useRouter();
  const chime = useMemo(() => createChime(), []);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NoticeFilter>('unread');
  const [page, setPage] = useState<{
    readonly state: 'loading' | 'error' | 'ready';
    readonly items: readonly Notice[];
    readonly next: string | null;
    readonly loadingMore: boolean;
    readonly now: number;
  }>({ state: 'loading', items: [], next: null, loadingMore: false, now: 0 });
  const [markingAll, setMarkingAll] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const soundOnRef = useRef(true);
  const lastUnread = useRef<number | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  const listRequest = useRef(0);

  const loadList = useCallback(async (show: NoticeFilter, before: string | null = null) => {
    const request = ++listRequest.current;
    if (before === null) {
      setPage((current) => ({ ...current, state: 'loading', items: [], next: null }));
    } else {
      setPage((current) => ({ ...current, loadingMore: true }));
    }
    const query = before === null ? `show=${show}` : `show=${show}&before=${before}`;
    const result = await callApi<NoticePage>('GET', `${BASE}?${query}`);
    if (request !== listRequest.current) return;
    if (!result.ok) {
      setPage((current) =>
        before === null
          ? { state: 'error', items: [], next: null, loadingMore: false, now: Date.now() }
          : { ...current, loadingMore: false },
      );
      return;
    }
    setPage((current) => ({
      state: 'ready',
      items: before === null ? result.body.items : [...current.items, ...result.body.items],
      next: result.body.next,
      loadingMore: false,
      now: Date.now(),
    }));
  }, []);

  const heard = useCallback(
    async (newest: Notice | null) => {
      let rang = false;
      await exclusive(() => {
        const last = readStored(HEARD_KEY);
        rang = shouldRing(newest, last, RINGING_KINDS);
        writeStored(HEARD_KEY, laterNotice(newest?.id ?? null, last));
      });
      if (!rang) return;
      channel.current?.postMessage('rang');
      if (soundOnRef.current && !(await chime.play())) setSoundBlocked(true);
    },
    [chime],
  );

  // The badge: poll while the tab is visible; pause while hidden; ask at once on return.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastPoll = 0;

    async function poll() {
      lastPoll = Date.now();
      const result = await callApi<UnreadNotices>('GET', `${BASE}/unread-count`);
      if (stopped) return;
      if (!result.ok) {
        // Signed out, or no longer allowed: the badge stops asking until the next page load.
        if (result.failure.status === 401 || result.failure.status === 403) {
          stopped = true;
          clearInterval(timer);
        }
        return;
      }
      const { unread: count, newest } = result.body;
      if (lastUnread.current !== null && count > lastUnread.current) {
        setAnnouncement(t('announce', { count }));
      }
      lastUnread.current = count;
      setUnread(count);
      await heard(newest);
    }
    pollRef.current = poll;

    function schedule() {
      clearInterval(timer);
      if (stopped || document.visibilityState !== 'visible') return;
      timer = setInterval(() => void poll(), SELLER_POLL_MILLISECONDS);
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        if (!stopped) void poll();
        schedule();
      } else {
        clearInterval(timer);
      }
    }
    function onFocus() {
      // Focus often follows a visibility change; skip it when that poll has just run.
      if (!stopped && Date.now() - lastPoll > 5_000) void poll();
    }

    if (typeof BroadcastChannel === 'function') {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = () => {
        if (!stopped) void poll();
      };
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    if (document.visibilityState === 'visible') void poll();
    schedule();
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      channel.current?.close();
      channel.current = null;
    };
  }, [heard, t]);

  // The per-device sound switch, and whether the browser still blocks sound on this page.
  useEffect(() => {
    const on = readStored(SOUND_KEY) !== 'off';
    soundOnRef.current = on;
    setSoundOn(on);
    if (!on) return undefined;
    let done = false;
    void chime.unlock().then((ready) => {
      if (!done) setSoundBlocked(!ready);
    });
    // Any click or key on the page lets sound play; the hint then goes away by itself.
    const unlock = () => {
      void chime.unlock().then((ready) => {
        if (ready && !done) setSoundBlocked(false);
      });
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      done = true;
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, [chime]);

  function toggleSound() {
    const next = !soundOn;
    soundOnRef.current = next;
    setSoundOn(next);
    writeStored(SOUND_KEY, next ? 'on' : 'off');
    if (next) {
      void chime.unlock().then((ready) => setSoundBlocked(!ready));
    } else {
      setSoundBlocked(false);
    }
  }

  function openDrawer() {
    setOpen(true);
    void loadList(filter);
  }

  function chooseFilter(next: NoticeFilter) {
    setFilter(next);
    void loadList(next);
  }

  async function openItem(item: NoticeItem, event: MouseEvent<HTMLAnchorElement>) {
    // A new-tab click opens the page as a link does; the notice stays unread until opened here.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (!item.read) {
      await callApi('POST', `${BASE}/${item.id}/read`, {}, csrfToken);
      void pollRef.current();
    }
    setOpen(false);
    router.push(item.href);
  }

  async function markAll() {
    setMarkingAll(true);
    const result = await callApi('POST', `${BASE}/read-all`, {}, csrfToken);
    setMarkingAll(false);
    if (!result.ok) return;
    lastUnread.current = 0;
    setUnread(0);
    void loadList(filter);
  }

  const list: NoticeListState =
    page.state === 'ready'
      ? {
          kind: 'ready',
          items: page.items.map((notice) => toItem(notice, page.now)),
          hasMore: page.next !== null,
          loadingMore: page.loadingMore,
        }
      : { kind: page.state };

  function toItem(notice: Notice, now: number): NoticeItem {
    const at = new Date(notice.createdAt);
    const orderPaid = notice.kind === ORDER_PAID;
    return {
      id: notice.id,
      href:
        orderPaid && notice.params.sellerOrderId
          ? `/orders/${notice.params.sellerOrderId}`
          : '/orders',
      ownerName: null,
      icon: 'clipboard',
      tone: 'success',
      message: t.rich('kind.order-paid', {
        items: notice.params.items ?? 0,
        strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
      }),
      time: format.relativeTime(at, now),
      dateTime: notice.createdAt,
      category: t('category.orders'),
      read: notice.read,
    };
  }

  return (
    <div className="me-3 flex items-center gap-1">
      {soundOn && soundBlocked ? (
        <button
          type="button"
          onClick={() => void chime.unlock().then((ready) => setSoundBlocked(!ready))}
          className="inline-flex min-h-(--mp-size-control-sm) min-w-(--mp-size-control-sm) items-center justify-center gap-1.5 rounded-full border border-transparent px-2 text-xs font-medium text-fg-secondary hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus sm:border-line-control sm:px-3"
        >
          <Icon name="volume-off" />
          {/* Phones show the icon alone; the name stays for screen readers. */}
          <span className="sr-only sm:not-sr-only">{t('enable-sound')}</span>
        </button>
      ) : null}
      <NotificationBell
        unread={unread}
        expanded={open}
        onClick={openDrawer}
        label={unread > 0 ? t('bell-unread', { count: unread }) : t('bell')}
      />
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      <NotificationDrawer
        open={open}
        onClose={() => setOpen(false)}
        unread={unread}
        filter={filter}
        onFilter={chooseFilter}
        list={list}
        onOpenItem={(item, event) => void openItem(item, event)}
        onMarkAll={() => void markAll()}
        markingAll={markingAll}
        onLoadMore={() => {
          if (page.next !== null) void loadList(filter, page.next);
        }}
        onRetry={() => void loadList(filter)}
        sound={{ on: soundOn, onToggle: toggleSound }}
        labels={{
          title: t('title'),
          close: t('close'),
          filters: t('filters'),
          unread: t('filter.unread'),
          read: t('filter.read'),
          all: t('filter.all'),
          unreadCount: t('unread-count', { count: unread }),
          soundOn: t('sound-on'),
          soundOff: t('sound-off'),
          markAll: t('mark-all'),
          loadMore: t('load-more'),
          unreadItem: t('unread-item'),
          empty: {
            unread: { title: t('empty.unread.title'), body: t('empty.unread.body') },
            read: { title: t('empty.read.title'), body: t('empty.read.body') },
            all: { title: t('empty.all.title'), body: t('empty.all.body') },
          },
          error: t('error'),
          retry: t('retry'),
          loading: t('loading'),
        }}
      />
    </div>
  );
}
