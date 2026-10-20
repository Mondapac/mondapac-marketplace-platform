'use client';

import {
  createChime,
  NoticeCenter,
  SELLER_POLL_MILLISECONDS,
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
  ACCESS_CHANGED,
  CERTIFICATE_DECIDED,
  CERTIFICATE_ENDED,
  CERTIFICATE_EXPIRING,
  IMAGE_TAKEN_DOWN,
  ISSUER_REQUEST_ANSWERED,
  LOW_STOCK,
  OFFER_CHANGES_REQUESTED,
  OFFER_PUBLISHED,
  OFFER_TAG_CHANGED,
  ORDER_PAID,
  PRICE_HOLD_DECIDED,
  PRODUCT_CHANGES_REQUESTED,
  PRODUCT_PUBLISHED,
  RINGING_KINDS,
  type ListedNotice,
} from './types.ts';

const BASE = 'notifications/seller/notices';
/**
 * Names this panel's browser state: the newest notice already rung and the sound switch (shared
 * by the panel's tabs), and the channel on which tabs tell each other a notice rang, so their
 * badges follow at once (and do not ring again).
 */
const STORAGE = 'mp.seller.notices';

interface Look {
  readonly icon: IconName;
  readonly tone: NoticeTone;
  readonly category: string;
}

/**
 * How each kind looks (plan 6c): orders success, certificates and catalog info, stock and
 * prices attention, access neutral. A refusal or a loss (declined, revoked, taken down,
 * suspended, rejected) is attention, whatever its group.
 */
function lookOf(notice: ListedNotice): Look {
  const { outcome, cause, change } = notice.params;
  const bad =
    outcome === 'declined' ||
    outcome === 'rejected' ||
    outcome === 'changes-requested' ||
    outcome === 'not-accepted' ||
    cause !== undefined ||
    change === 'suspended' ||
    change === 'removed';
  switch (notice.kind) {
    case ORDER_PAID:
      return { icon: 'clipboard', tone: 'success', category: 'orders' };
    case LOW_STOCK:
      return { icon: 'package', tone: 'attention', category: 'stock' };
    case CERTIFICATE_DECIDED:
    case CERTIFICATE_EXPIRING:
    case CERTIFICATE_ENDED:
    case ISSUER_REQUEST_ANSWERED:
      return {
        icon: 'shield-check',
        tone: bad || notice.kind === CERTIFICATE_EXPIRING ? 'attention' : 'info',
        category: 'certificates',
      };
    case OFFER_PUBLISHED:
    case PRODUCT_PUBLISHED:
      return { icon: 'store', tone: 'success', category: 'catalogue' };
    case OFFER_CHANGES_REQUESTED:
    case PRODUCT_CHANGES_REQUESTED:
    case IMAGE_TAKEN_DOWN:
      return { icon: 'store', tone: 'attention', category: 'catalogue' };
    case OFFER_TAG_CHANGED:
      return { icon: 'shield-check', tone: bad ? 'attention' : 'info', category: 'catalogue' };
    case PRICE_HOLD_DECIDED:
      return { icon: 'tag', tone: bad ? 'attention' : 'success', category: 'prices' };
    case ACCESS_CHANGED:
      return { icon: 'key', tone: 'neutral', category: 'account' };
    default:
      return { icon: 'bell', tone: 'neutral', category: 'other' };
  }
}

/**
 * The page a notice opens: its order, Offer, stock, prices or product. Certificates have no
 * seller page yet, so their rows only mark the notice read.
 */
function hrefOf(notice: ListedNotice): string | null {
  const { sellerOrderId, offerId, productId } = notice.params;
  switch (notice.kind) {
    case ORDER_PAID:
      return sellerOrderId ? `/orders/${sellerOrderId}` : '/orders';
    case LOW_STOCK:
      return offerId ? `/offers/${offerId}/stock` : null;
    case PRICE_HOLD_DECIDED:
      return offerId ? `/offers/${offerId}/prices` : null;
    case OFFER_PUBLISHED:
    case OFFER_CHANGES_REQUESTED:
    case OFFER_TAG_CHANGED:
      return offerId ? `/offers/${offerId}` : null;
    case PRODUCT_PUBLISHED:
    case PRODUCT_CHANGES_REQUESTED:
    case IMAGE_TAKEN_DOWN:
      return productId ? `/products/${productId}` : null;
    case ACCESS_CHANGED:
      return '/';
    default:
      return null;
  }
}

/**
 * The seller topbar's bell (in-app notifications package 2; the other seller notices of package
 * 4 open their Offer, stock, prices or product): the unread badge, polled every
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
    if (item.href === null) return;
    feed.close();
    router.push(item.href);
  }

  function message(notice: ListedNotice): ReactNode {
    const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;
    const p = notice.params;
    // ICU select keys take no hyphen: an enum value is passed with `_` for `-`. Every enum
    // falls back to `other`, so a value this panel does not know yet still reads.
    const key = (value: string | undefined) => (value ?? 'other').replaceAll('-', '_');
    switch (notice.kind) {
      case ORDER_PAID: {
        const customer = notice.customerShortName ?? null;
        const rich = { items: p.items ?? 0, strong };
        // The name is a text value, never markup: next-intl renders it as escaped text.
        return customer === null
          ? t.rich('kind.order-paid', rich)
          : t.rich('kind.order-paid-by', { ...rich, name: customer });
      }
      case LOW_STOCK:
        return t.rich('kind.low-stock', { strong, left: p.onlyLeft ?? 0 });
      case CERTIFICATE_DECIDED:
        return t.rich('kind.certificate-decided', { strong, outcome: key(p.outcome) });
      case CERTIFICATE_EXPIRING:
        return t.rich('kind.certificate-expiring', { strong, days: p.days ?? 0 });
      case CERTIFICATE_ENDED:
        return t.rich('kind.certificate-ended', { strong, cause: key(p.cause) });
      case ISSUER_REQUEST_ANSWERED:
        return t.rich('kind.issuer-request-answered', { strong, outcome: key(p.outcome) });
      case OFFER_PUBLISHED:
        return t.rich('kind.offer-published', { strong });
      case OFFER_CHANGES_REQUESTED:
        return t.rich('kind.offer-changes-requested', { strong, reason: key(p.reason) });
      case PRODUCT_PUBLISHED:
        return t.rich('kind.product-published', { strong });
      case PRODUCT_CHANGES_REQUESTED:
        return t.rich('kind.product-changes-requested', { strong, reason: key(p.reason) });
      case OFFER_TAG_CHANGED:
        return t.rich('kind.offer-tag-changed', { strong, change: key(p.change) });
      case IMAGE_TAKEN_DOWN:
        return t.rich('kind.image-taken-down', { strong, reason: key(p.reason) });
      case PRICE_HOLD_DECIDED:
        return t.rich('kind.price-hold-decided', {
          strong,
          outcome: key(p.outcome),
          priceKind: key(p.priceKind),
        });
      case ACCESS_CHANGED:
        return t.rich('kind.access-changed', { strong, change: key(p.change) });
      default:
        return t('kind.other');
    }
  }

  function toItem(notice: ListedNotice, now: number): NoticeItem {
    const look = lookOf(notice);
    return {
      id: notice.id,
      href: hrefOf(notice),
      // Only an order notice names someone: the customer's short name, when the list carries it.
      ownerName: notice.kind === ORDER_PAID ? (notice.customerShortName ?? null) : null,
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
