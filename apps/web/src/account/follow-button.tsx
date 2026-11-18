'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatInstantDay } from '../format/instant.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import {
  followStore,
  isSellerId,
  readFollow,
  readFollowGift,
  unfollowStore,
  type FollowGift,
} from './follow-api.ts';
import { useDialog } from './use-dialog.ts';

// The Follow toggle of the store page and the seller card (customers management phase 3; Reza's
// spec 4). One button with `aria-pressed`; the change shows at once and is rolled back when the
// API refuses. Signed out, the tap opens the log-in dialog and the follow is applied after sign-in
// (the intent waits in this tab's session storage; the dialog sends the buyer back to this page).
// The privacy line says what the store sees. After a new Follow, the store's live follower offers
// show in a small dialog; a failed gift read is silent.

/** How long the status line stays. */
export const ANNOUNCE_MS = 5000;

const INTENT_KEY = 'follow-intent';

interface Intent {
  readonly sellerId: string;
  readonly path: string;
  /** When the buyer tapped Follow (ms); an intent older than {@link INTENT_MAX_AGE_MS} is dropped. */
  readonly at: number;
}

const INTENT_MAX_AGE_MS = 10 * 60 * 1000;
/** A path of this site only: one slash first, never `//` or `/\` (those leave the site). */
const LOCAL_PATH = /^\/(?![/\\])/;

/** The follow a signed-out buyer asked for, if any (read by the log-in dialog and the button). */
export function readFollowIntent(): Intent | null {
  try {
    const raw = window.sessionStorage.getItem(INTENT_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      isSellerId((parsed as Intent).sellerId) &&
      typeof (parsed as Intent).path === 'string' &&
      LOCAL_PATH.test((parsed as Intent).path) &&
      typeof (parsed as Intent).at === 'number' &&
      Date.now() - (parsed as Intent).at < INTENT_MAX_AGE_MS
    )
      return parsed as Intent;
    if (parsed !== null) window.sessionStorage.removeItem(INTENT_KEY);
  } catch {
    // Storage is blocked: no intent is kept.
  }
  return null;
}

export function clearFollowIntent(): void {
  try {
    window.sessionStorage.removeItem(INTENT_KEY);
  } catch {
    // Nothing to clear.
  }
}

function keepFollowIntent(intent: Omit<Intent, 'at'>): void {
  try {
    window.sessionStorage.setItem(INTENT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
  } catch {
    // The buyer taps Follow again after signing in.
  }
}

type Problem = 'failed' | 'not-found' | 'limit' | 'throttled' | null;

/** One gift as one line: "10% off, from $50, until 30 Nov 2026". */
export function useGiftLine(): (gift: FollowGift) => string {
  const t = useTranslations('follow');
  const locale = useLocale();
  return useCallback(
    (gift) => {
      const reward =
        gift.reward.kind === 'PERCENT'
          ? t('percent-off', { percent: gift.reward.bps / 100 })
          : t('amount-off', {
              amount: formatMoney(
                { amount: gift.reward.amountMinor, currency: gift.currency },
                locale,
              ),
            });
      const parts = [`${gift.name}: ${reward}`];
      if (gift.minSpendMinor !== null)
        parts.push(
          t('min-spend', {
            amount: formatMoney({ amount: gift.minSpendMinor, currency: gift.currency }, locale),
          }),
        );
      if (gift.endsAt !== null)
        parts.push(
          t('until', {
            date: formatInstantDay(gift.endsAt, locale),
          }),
        );
      return parts.join(', ');
    },
    [t, locale],
  );
}

/**
 * The Follow toggle with its privacy line and, on the store page, the gift line. `slug` is the
 * store's address when it is known (the dialog's "Shop" link).
 */
export function FollowControl({
  sellerId,
  storeName,
  slug,
  variant,
}: {
  readonly sellerId: string | undefined;
  readonly storeName: string;
  readonly slug?: string;
  readonly variant: 'page' | 'card';
}) {
  const t = useTranslations('follow');
  const path = usePathname();
  const giftLine = useGiftLine();
  const { live, customer, sessionReady, setLoginOpen } = useStore();
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [announce, setAnnounce] = useState('');
  const [wait, setWait] = useState(1);
  const button = useRef<HTMLButtonElement>(null);
  const [help, setHelp] = useState(false);
  const [gifts, setGifts] = useState<readonly FollowGift[]>([]);
  const [dialog, setDialog] = useState<readonly FollowGift[] | null>(null);
  const helpId = useId();
  const active = live && isSellerId(sellerId);
  const signedIn = customer !== null;
  const busyRef = useRef(false);
  // The buyer changed the follow here: a slower read of the old state must not undo it.
  const touched = useRef(false);

  // The store's offers for followers, for the line under the button (the page only).
  useEffect(() => {
    if (!active || variant !== 'page') return;
    let current = true;
    void readFollowGift(sellerId).then((read) => {
      if (current && read.kind === 'ok') setGifts(read.value);
    });
    return () => {
      current = false;
    };
  }, [active, sellerId, variant]);

  const follow = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      touched.current = true;
      setBusy(true);
      setProblem(null);
      setFollowing(true);
      const result = await followStore(id);
      busyRef.current = false;
      setBusy(false);
      if (result.kind === 'ok' && result.value.following) {
        setAnnounce(t('following-announce', { store: storeName }));
        const gift = await readFollowGift(id);
        if (gift.kind === 'ok' && gift.value.length > 0) setDialog(gift.value);
        return;
      }
      setFollowing(false);
      if (result.kind === 'signed-out') return setLoginOpen(true);
      if (result.kind === 'throttled') {
        setWait(Math.max(1, Math.ceil((result.retryAfterSeconds ?? 60) / 60)));
        return setProblem('throttled');
      }
      if (result.kind === 'invalid' && result.code === 'engagement.store-not-found')
        return setProblem('not-found');
      if (result.kind === 'invalid' && result.code === 'engagement.follow-limit')
        return setProblem('limit');
      setProblem('failed');
    },
    [storeName, t, setLoginOpen],
  );

  // The status line ("Following {store}") shows for a few seconds, then goes.
  useEffect(() => {
    if (announce === '') return;
    const timer = setTimeout(() => setAnnounce(''), ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [announce]);

  // What the buyer's account says now; a follow asked for before signing in is applied here.
  useEffect(() => {
    if (!active || !signedIn || !sessionReady) return;
    let current = true;
    const intent = readFollowIntent();
    if (intent?.sellerId === sellerId) {
      clearFollowIntent();
      void follow(sellerId);
      return;
    }
    void readFollow(sellerId).then((read) => {
      if (current && !touched.current)
        setFollowing(read.kind === 'ok' ? read.value.following : null);
    });
    return () => {
      current = false;
    };
  }, [active, signedIn, sessionReady, sellerId, follow]);

  if (!active) return null;

  const unfollow = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    touched.current = true;
    setBusy(true);
    setProblem(null);
    setFollowing(false);
    const result = await unfollowStore(sellerId);
    busyRef.current = false;
    setBusy(false);
    if (result.kind === 'ok') return setAnnounce(t('unfollowed-announce', { store: storeName }));
    setFollowing(true);
    if (result.kind === 'signed-out') return setLoginOpen(true);
    if (result.kind === 'throttled') {
      setWait(Math.max(1, Math.ceil((result.retryAfterSeconds ?? 60) / 60)));
      return setProblem('throttled');
    }
    setProblem('failed');
  };

  const onClick = () => {
    if (!signedIn) {
      keepFollowIntent({ sellerId, path });
      setLoginOpen(true);
      return;
    }
    if (following === true) void unfollow();
    else void follow(sellerId);
  };

  const on = following === true;
  return (
    <div className={`fl fl-${variant}`}>
      <button
        className={on ? 'btn fl-btn on' : 'btn ghost fl-btn'}
        type="button"
        aria-pressed={on}
        aria-describedby={problem === null ? undefined : `${helpId}-err`}
        ref={button}
        disabled={busy}
        onClick={onClick}
      >
        {busy ? <span className="fl-spin" aria-hidden="true" /> : on ? <Icon name="check" /> : null}
        {on ? t('following') : t('follow')}
        <span className="fl-sr"> {storeName}</span>
      </button>
      <div className="fl-live" role="status" aria-live="polite">
        {announce}
      </div>
      {problem === null ? null : (
        <p className="fl-err" id={`${helpId}-err`} role="alert">
          {problem === 'not-found'
            ? t('error-not-found')
            : problem === 'throttled'
              ? t('error-throttled', { minutes: wait })
              : problem === 'limit'
                ? t.rich('error-limit', {
                    link: (chunks) => <Link href="/account/stores">{chunks}</Link>,
                  })
                : t('error-failed')}
        </p>
      )}
      {variant === 'page' && !on && gifts.length > 0 ? (
        <p className="fl-gift">{t('follow-to-get', { offer: giftLine(gifts[0]!) })}</p>
      ) : null}
      <p className="fl-privacy">
        {t('privacy')}{' '}
        <button
          className="lnk"
          type="button"
          aria-expanded={help}
          aria-controls={`${helpId}-help`}
          onClick={() => setHelp((open) => !open)}
        >
          {t('learn-more')}
        </button>
      </p>
      <p className="fl-help" id={`${helpId}-help`} hidden={!help}>
        {t('privacy-help')}
      </p>
      {dialog === null ? null : (
        <GiftDialog
          gifts={dialog}
          storeName={storeName}
          shopHref={variant === 'card' && slug !== undefined ? `/s/${slug}` : undefined}
          onClose={() => {
            setDialog(null);
            // The button was disabled while the follow ran, so focus went nowhere: bring it back.
            button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

/** "Thanks for following {store}": the offers, one line each. Focus stays inside; Esc closes. */
function GiftDialog({
  gifts,
  storeName,
  shopHref,
  onClose,
}: {
  readonly gifts: readonly FollowGift[];
  readonly storeName: string;
  readonly shopHref: string | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('follow');
  const giftLine = useGiftLine();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useDialog(mounted, onClose, panel);
  if (!mounted) return null;
  return createPortal(
    <div className="amw open">
      <div className="amscrim" onClick={onClose} />
      <div className="ambox">
        <div
          className="amdlg"
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className="amh">
            <h2 id={titleId}>{t('thanks', { store: storeName })}</h2>
            <button className="iconbtn" type="button" aria-label={t('close')} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
          <ul className="fl-gifts">
            {gifts.map((gift) => (
              <li key={`${gift.name}-${gift.endsAt ?? ''}`}>{giftLine(gift)}</li>
            ))}
          </ul>
          <p>{t('gift-applies')}</p>
          <div className="ac-acts">
            {shopHref === undefined ? null : (
              <Link className="btn" href={shopHref} onClick={onClose}>
                {t('shop', { store: storeName })}
              </Link>
            )}
            <button
              className={shopHref === undefined ? 'btn' : 'btn ghost'}
              type="button"
              onClick={onClose}
            >
              {t('close')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
