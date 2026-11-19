'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { joinStore } from '../account/follow-api.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { clearInvite, keepInvite, readInvite, type KeptInvite } from './invite-cookie.ts';

// The invite link of a store (customers management phase 4a): the banner on `/invite/<token>`,
// the sign-up line, the join call after the account exists and the note for a link that no longer
// works. The token lives in a first-party cookie for the sign-up journey and nowhere else.

// Banners on screen now: the shell's join prompt stays out of the way while one is shown, so the
// choice is offered once.
let banners = 0;
const listeners = new Set<() => void>();
const bannerShown = () => banners > 0;
const onBanner = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function countBanner(delta: number): void {
  banners += delta;
  listeners.forEach((listener) => listener());
}

/**
 * "{Store} invited you": a signed-out visitor keeps the token for the sign-up and gets Create
 * account and Sign in; a signed-in one gets the Join choice (nothing is joined without a click).
 * The token leaves the address bar once it is read.
 */
export function InviteBanner({
  token,
  slug,
  storeName,
}: {
  readonly token: string;
  readonly slug: string;
  readonly storeName: string;
}) {
  const t = useTranslations('invite');
  const { customer, setLoginOpen, sessionReady, live } = useStore();
  const signedIn = customer !== null;
  useEffect(() => {
    countBanner(1);
    // The token is a credential: it leaves the address bar and the history entry.
    window.history.replaceState(window.history.state, '', `/s/${slug}`);
    return () => countBanner(-1);
  }, [slug]);
  useEffect(() => {
    if (sessionReady && !signedIn) keepInvite(token, storeName);
  }, [token, storeName, sessionReady, signedIn]);
  return (
    <section className="inv-banner" aria-labelledby="invite-title">
      <Icon name="store" />
      <div>
        <h2 id="invite-title">{t('banner-title', { store: storeName })}</h2>
        <p>{t('banner-body')}</p>
      </div>
      {signedIn ? (
        live ? (
          <JoinPanel invite={{ token, storeName }} />
        ) : null
      ) : (
        <div className="ac-acts">
          <Link className="btn" href="/account?create=1">
            {t('create-account')}
          </Link>
          <button className="btn ghost" type="button" onClick={() => setLoginOpen(true)}>
            {t('sign-in')}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The line above the Create account button: who the buyer joins through. Nothing without a kept
 * link. "Not now" forgets the link.
 */
export function InviteSignUpLine() {
  const t = useTranslations('invite');
  const [invite, setInvite] = useState<KeptInvite | null>(null);
  useEffect(() => setInvite(readInvite()), []);
  if (invite === null) return null;
  return (
    <div className="ac-note" role="note">
      <Icon name="info" />
      <span>
        {t('sign-up-line', { store: invite.storeName ?? t('the-store') })}{' '}
        <button
          className="lnk"
          type="button"
          onClick={() => {
            clearInvite();
            setInvite(null);
          }}
        >
          {t('not-now')}
        </button>
      </span>
    </div>
  );
}

type Notice = 'joined' | 'joined-only' | 'not-eligible' | 'unavailable' | null;

const RETRY_MS = 2000;
const NOTICE_MS = 10000;

/**
 * The join choice: what joining means and a Join button. Only the click calls the API (a refused
 * or declined link is forgotten at once). An outage right after sign-up is tried once more after 2
 * seconds, then noted; the account is never touched.
 */
function JoinPanel({ invite }: { readonly invite: { token: string; storeName: string | null } }) {
  const t = useTranslations('invite');
  const store = invite.storeName ?? t('the-store');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Notice | 'declined' | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (done === null) return;
    const timer = setTimeout(() => setGone(true), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  const join = async () => {
    setBusy(true);
    let result = await joinStore(invite.token);
    if (result.kind === 'failed') {
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS));
      result = await joinStore(invite.token);
    }
    setBusy(false);
    if (result.kind === 'signed-out') return;
    clearInvite();
    if (result.kind === 'ok') return setDone(result.value.following ? 'joined' : 'joined-only');
    if (result.kind === 'invalid')
      return setDone(
        result.code === 'customers.invitation-not-eligible' ? 'not-eligible' : 'unavailable',
      );
    setDone('unavailable');
  };

  if (gone) return null;
  return (
    <div className="inv-join" role="group" aria-label={t('join', { store })}>
      {done === null ? (
        <>
          <p>{t('join-help', { store })}</p>
          <div className="ac-acts">
            <button className="btn" type="button" disabled={busy} onClick={() => void join()}>
              {busy ? t('joining') : t('join', { store })}
            </button>
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                clearInvite();
                setDone('declined');
              }}
            >
              {t('decline')}
            </button>
          </div>
        </>
      ) : null}
      <div role="status" aria-live="polite">
        {done === null ? null : (
          <p className="ac-note">
            <Icon name="info" />
            <span>{t(`notice.${done}`, { store })}</span>
            <button className="lnk" type="button" onClick={() => setGone(true)}>
              {t('dismiss')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Mounted once in the shell. A signed-in customer with a kept invite link (a sign-up or sign-in
 * that followed an invite page) is asked whether to join; nothing is sent until they say yes. The
 * link is forgotten when the customer signs out.
 */
export function InviteJoiner() {
  const { live, customer, sessionReady } = useStore();
  const [invite, setInvite] = useState<KeptInvite | null>(null);
  const banner = useSyncExternalStore(onBanner, bannerShown, () => false);
  const signedIn = customer !== null;
  const wasSignedIn = useRef(false);

  useEffect(() => {
    if (!sessionReady) return;
    if (wasSignedIn.current && !signedIn) clearInvite();
    wasSignedIn.current = signedIn;
    setInvite(live && signedIn ? readInvite() : null);
  }, [live, signedIn, sessionReady]);

  if (invite === null || banner) return null;
  return (
    <div className="inv-banner">
      <JoinPanel key={invite.token} invite={invite} />
    </div>
  );
}

/** The note on the home page after a link that no longer works; dismissible. */
export function InviteInvalidNote() {
  const t = useTranslations('invite');
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <p className="ac-note inv-invalid" role="status">
      <Icon name="info" />
      <span>{t('invalid')}</span>
      <button className="lnk" type="button" onClick={() => setOpen(false)}>
        {t('dismiss')}
      </button>
    </p>
  );
}
