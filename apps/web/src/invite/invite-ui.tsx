'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { joinStore } from '../account/follow-api.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { clearInvite, keepInvite, readInvite, type KeptInvite } from './invite-cookie.ts';

// The invite link of a store (customers management phase 4a): the banner on `/invite/<token>`,
// the sign-up line, the join call after the account exists and the note for a link that no longer
// works. The token lives in a first-party cookie for the sign-up journey and nowhere else.

/** "{Store} invited you": keeps the token for the sign-up and offers Create account and Sign in. */
export function InviteBanner({
  token,
  storeName,
}: {
  readonly token: string;
  readonly storeName: string;
}) {
  const t = useTranslations('invite');
  const { customer, setLoginOpen } = useStore();
  useEffect(() => keepInvite(token, storeName), [token, storeName]);
  return (
    <section className="inv-banner" aria-labelledby="invite-title">
      <Icon name="store" />
      <div>
        <h2 id="invite-title">{t('banner-title', { store: storeName })}</h2>
        <p>{t('banner-body')}</p>
      </div>
      {customer === null ? (
        <div className="ac-acts">
          <Link className="btn" href="/account?create=1">
            {t('create-account')}
          </Link>
          <button className="btn ghost" type="button" onClick={() => setLoginOpen(true)}>
            {t('sign-in')}
          </button>
        </div>
      ) : null}
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
 * Once a customer is signed in and an invite link is kept, claims it: the store is followed and a
 * notice says so. Mounted once in the shell. A link that cannot be used ends quietly; an outage
 * right after sign-up is tried once more after 2 seconds, then noted. The account is never touched.
 */
export function InviteJoiner() {
  const t = useTranslations('invite');
  const { live, customer, sessionReady } = useStore();
  const [notice, setNotice] = useState<{ kind: Notice; store: string } | null>(null);
  const running = useRef(false);
  const signedIn = customer !== null;

  useEffect(() => {
    if (!live || !signedIn || !sessionReady || running.current) return;
    const invite = readInvite();
    if (invite === null) return;
    running.current = true;
    const store = invite.storeName ?? t('the-store');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (kind: Notice) => setNotice({ kind, store });
    const finish = (kind: Notice) => {
      clearInvite();
      running.current = false;
      if (kind !== null) show(kind);
    };
    const attempt = async (again: boolean): Promise<void> => {
      const result = await joinStore(invite.token);
      if (result.kind === 'ok') return finish(result.value.following ? 'joined' : 'joined-only');
      if (result.kind === 'signed-out') {
        running.current = false;
        return;
      }
      if (result.kind === 'invalid')
        return finish(result.code === 'customers.invitation-not-eligible' ? 'not-eligible' : null);
      if (again) {
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RETRY_MS);
        });
        return attempt(false);
      }
      finish('unavailable');
    };
    void attempt(true);
    return () => clearTimeout(timer);
  }, [live, signedIn, sessionReady, t]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className="inv-live" role="status" aria-live="polite">
      {notice === null || notice.kind === null ? null : (
        <p className="ac-note">
          <Icon name="info" />
          <span>{t(`notice.${notice.kind}`, { store: notice.store })}</span>
          <button className="lnk" type="button" onClick={() => setNotice(null)}>
            {t('dismiss')}
          </button>
        </p>
      )}
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
