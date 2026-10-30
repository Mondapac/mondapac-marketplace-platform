'use client';

import {
  ADMIN_POLL_MILLISECONDS,
  createChime,
  NoticeCenter,
  useNoticeFeed,
  type IconName,
  type NoticeItem,
  type NoticeTone,
} from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import {
  CERTIFICATE_SUBMITTED,
  DELIVERY_FALLBACK_OVER_CAP,
  PRICE_HOLD_OPENED,
  PRODUCT_REVISION_SUBMITTED,
  RINGING_KINDS,
  SELLER_FILE_SUBMITTED,
  type AdminNotice,
} from './types.ts';

const BASE = 'notifications/admin/notices';
/** Names this panel's browser state (heard notice, sound switch, tab channel); see the hook. */
const STORAGE = 'mp.admin.notices';

/** How each kind looks (plan 6c): certificates and products info, prices attention. */
const LOOK: Readonly<
  Record<string, { readonly icon: IconName; readonly tone: NoticeTone; readonly category: string }>
> = {
  [CERTIFICATE_SUBMITTED]: { icon: 'shield-check', tone: 'info', category: 'certificates' },
  [PRODUCT_REVISION_SUBMITTED]: { icon: 'package', tone: 'info', category: 'products' },
  [SELLER_FILE_SUBMITTED]: { icon: 'store', tone: 'neutral', category: 'sellers' },
  [PRICE_HOLD_OPENED]: { icon: 'tag', tone: 'attention', category: 'prices' },
  [DELIVERY_FALLBACK_OVER_CAP]: { icon: 'map-pin', tone: 'attention', category: 'delivery' },
};
const UNKNOWN_LOOK = { icon: 'bell', tone: 'neutral', category: 'other' } as const;

/**
 * The page a notice opens. Certificate and product reviews have no admin page yet, so their rows
 * only mark the notice read.
 */
function hrefOf(notice: AdminNotice): string | null {
  if (notice.kind === SELLER_FILE_SUBMITTED && notice.params.sellerId !== undefined) {
    return `/sellers/${notice.params.sellerId}`;
  }
  if (notice.kind === PRICE_HOLD_OPENED) return '/price-holds';
  if (notice.kind === DELIVERY_FALLBACK_OVER_CAP) return '/settings/delivery';
  return null;
}

/**
 * The admin topbar's bell (in-app notifications package 3): approval notices for the queues the
 * admin may work, polled every 60 s while the tab is visible (paused while hidden, asked again
 * on return), the drawer with its Unread / Read / All tabs, and a sound that is off until the
 * admin switches it on on this device. When on, it rings once per burst of new notices, in one
 * tab, and never as the only signal: the badge changes and a polite live region says so.
 */
export function AdminNotifications({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('notifications');
  const format = useFormatter();
  const router = useRouter();
  const chime = useMemo(() => createChime(), []);
  const feed = useNoticeFeed<AdminNotice>({
    call: callApi,
    base: BASE,
    csrfToken,
    pollMilliseconds: ADMIN_POLL_MILLISECONDS,
    storageName: STORAGE,
    ringingKinds: RINGING_KINDS,
    soundByDefault: false,
    chime,
    announce: (count) => t('announce', { count }),
  });

  async function openItem(item: NoticeItem, event: MouseEvent<HTMLElement>) {
    // A new-tab click opens the page as a link does; the notice stays unread until opened here.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (!item.read) await feed.markRead(item.id);
    if (item.href === null) return;
    feed.close();
    router.push(item.href);
  }

  function message(notice: AdminNotice): ReactNode {
    const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;
    switch (notice.kind) {
      case CERTIFICATE_SUBMITTED:
        return t.rich('kind.certificate-submitted', {
          strong,
          submission: notice.params.submission ?? 'initial',
        });
      case PRODUCT_REVISION_SUBMITTED:
        return t.rich('kind.product-revision-submitted', { strong });
      case SELLER_FILE_SUBMITTED:
        return notice.params.fileKind === 'identity-change'
          ? t.rich('kind.seller-identity-changed', { strong })
          : t.rich('kind.seller-application-submitted', { strong });
      case PRICE_HOLD_OPENED:
        return t.rich('kind.price-hold-opened', {
          strong,
          direction: notice.params.direction ?? 'other',
        });
      case DELIVERY_FALLBACK_OVER_CAP:
        return t.rich('kind.delivery-fallback-over-cap', { strong });
      default:
        return t('kind.other');
    }
  }

  function toItem(notice: AdminNotice, now: number): NoticeItem {
    const look = LOOK[notice.kind] ?? UNKNOWN_LOOK;
    return {
      id: notice.id,
      href: hrefOf(notice),
      // No names on admin notices (v1): the kind's icon stands in for the avatar.
      ownerName: null,
      icon: look.icon,
      tone: look.tone,
      message: message(notice),
      time: format.relativeTime(new Date(notice.createdAt), now),
      dateTime: notice.createdAt,
      category: t(`category.${look.category}`),
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
