'use client';

import {
  createChime,
  NoticeCenter,
  SELLER_POLL_MILLISECONDS,
  useNoticeFeed,
  type NoticeItem,
} from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { ORDER_PAID, RINGING_KINDS, type ListedNotice } from './types.ts';

const BASE = 'notifications/seller/notices';
/**
 * Names this panel's browser state: the newest notice already rung and the sound switch (shared
 * by the panel's tabs), and the channel on which tabs tell each other a notice rang, so their
 * badges follow at once (and do not ring again).
 */
const STORAGE = 'mp.seller.notices';

/**
 * The seller topbar's bell (in-app notifications package 2): the unread badge, polled every
 * 30 s while the tab is visible (paused while hidden, asked again on return), the notices drawer
 * with its Unread / Read / All tabs, and the new-order sound, on by default. The sound rings once
 * per new order burst, in one tab, never on notices already waiting when the panel opens, and
 * never as the only signal: the badge changes and a polite live region says so.
 */
export function SellerNotifications({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('notifications');
  const format = useFormatter();
  const router = useRouter();
  const chime = useMemo(() => createChime(), []);
  const feed = useNoticeFeed<ListedNotice>({
    call: callApi,
    base: BASE,
    csrfToken,
    pollMilliseconds: SELLER_POLL_MILLISECONDS,
    storageName: STORAGE,
    ringingKinds: RINGING_KINDS,
    soundByDefault: true,
    chime,
    announce: (count) => t('announce', { count }),
  });

  async function openItem(item: NoticeItem, event: MouseEvent<HTMLElement>) {
    // A new-tab click opens the page as a link does; the notice stays unread until opened here.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (!item.read) await feed.markRead(item.id);
    feed.close();
    if (item.href !== null) router.push(item.href);
  }

  function toItem(notice: ListedNotice, now: number): NoticeItem {
    const at = new Date(notice.createdAt);
    const orderPaid = notice.kind === ORDER_PAID;
    const customer = orderPaid ? (notice.customerShortName ?? null) : null;
    const rich = {
      items: notice.params.items ?? 0,
      strong: (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>,
    };
    return {
      id: notice.id,
      href:
        orderPaid && notice.params.sellerOrderId
          ? `/orders/${notice.params.sellerOrderId}`
          : '/orders',
      ownerName: customer,
      icon: 'clipboard',
      tone: 'success',
      // The name is a text value, never markup: next-intl renders it as escaped text.
      message:
        customer === null
          ? t.rich('kind.order-paid', rich)
          : t.rich('kind.order-paid-by', { ...rich, name: customer }),
      time: format.relativeTime(at, now),
      dateTime: notice.createdAt,
      category: t('category.orders'),
      read: notice.read,
    };
  }

  const unread = feed.unread;
  return (
    <NoticeCenter
      feed={feed}
      toItem={toItem}
      onOpenItem={(item, event) => void openItem(item, event)}
      labels={{
        bell: unread > 0 ? t('bell-unread', { count: unread }) : t('bell'),
        enableSound: t('enable-sound'),
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
  );
}
