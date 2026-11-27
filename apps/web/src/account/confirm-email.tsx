'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import { useStore, type ConfirmOutcome } from '../shell/store-context.tsx';
import { resendVerification } from './customer-api.ts';
import { AcField, PasswordField } from './fields.tsx';
import { useLinkToken } from './link-token.ts';

type Refusal = Exclude<ConfirmOutcome, 'ok' | 'rejected'>;

/**
 * The page the mailed confirmation link opens (`ux.md` A4; identity design 6.7, 8.6 row 3): the
 * token comes from the fragment, the customer types the account's password, and confirming signs
 * them in. A link that cannot be used (expired, used, replaced; one answer for every cause) offers
 * a new one by email. Sample mode has no links: the page says the link cannot be used.
 */
export function ConfirmEmail() {
  const t = useTranslations('account.auth.confirm');
  const auth = useTranslations('account.auth');
  const { live, confirmEmail } = useStore();
  const link = useLinkToken();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [rejected, setRejected] = useState(false);
  const [done, setDone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // A new state moves the keyboard to its heading, so a screen reader hears what changed.
  useEffect(() => {
    if (done || rejected) heading.current?.focus({ preventScroll: true });
  }, [done, rejected]);

  if (link.state === 'checking')
    return (
      <Frame>
        <h1 className="ac-ah">{t('title')}</h1>
        <p role="status">{t('checking')}</p>
      </Frame>
    );
  if (done)
    return (
      <Frame>
        <h1 className="ac-ah" ref={heading} tabIndex={-1}>
          {t('done-title')}
        </h1>
        <div className="ac-note" role="status">
          <Icon name="check" />
          <span>{t('done-body')}</span>
        </div>
        <div className="ac-acts">
          <Link className="btn" href="/account">
            {t('to-account')}
          </Link>
          <Link className="btn ghost" href="/">
            {t('to-shop')}
          </Link>
        </div>
      </Frame>
    );
  if (link.state === 'missing' || rejected || !live)
    return (
      <Frame>
        <h1 className="ac-ah" ref={heading} tabIndex={-1}>
          {t('rejected-title')}
        </h1>
        <NewLink live={live} />
      </Frame>
    );
  const token = link.token;
  return (
    <Frame>
      <h1 className="ac-ah">{t('title')}</h1>
      <form
        className="ac-f"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setRefusal(null);
          void confirmEmail(token, password).then((outcome) => {
            setPending(false);
            setPassword('');
            if (outcome === 'ok') return setDone(true);
            if (outcome === 'rejected') return setRejected(true);
            setRefusal(outcome);
          });
        }}
      >
        <p>{t('body')}</p>
        <PasswordField
          label={auth('password')}
          name="password"
          autoComplete="current-password"
          value={password}
          onText={setPassword}
          required
        />
        {refusal ? (
          <p className="ac-note ac-warn" role="alert">
            <Icon name="info" />
            <span>{t(refusal)}</span>
          </p>
        ) : null}
        <div>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? t('confirming') : t('submit')}
          </button>
        </div>
      </form>
    </Frame>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="ac">
      <section className="ac-card ac-auth">
        <div className="ac-dc">{children}</div>
      </section>
    </div>
  );
}

/** "Link not usable": one explanation for every cause, and a new link for any address. */
function NewLink({ live }: { readonly live: boolean }) {
  const t = useTranslations('account.auth.confirm');
  const auth = useTranslations('account.auth');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'pending' | 'sent' | 'throttled' | 'failed'>('idle');
  return (
    <form
      className="ac-f"
      onSubmit={(event) => {
        event.preventDefault();
        if (!live) return setState('sent');
        setState('pending');
        void resendVerification(email.trim()).then((result) =>
          setState(
            result.kind === 'ok' ? 'sent' : result.kind === 'throttled' ? 'throttled' : 'failed',
          ),
        );
      }}
    >
      <p>{t('rejected-body')}</p>
      <AcField
        label={auth('email')}
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onText={setEmail}
        required
      />
      <div className="ac-live" role="status">
        {state === 'sent' ? (
          <p className="ac-note">
            <Icon name="check" />
            <span>{t('new-sent')}</span>
          </p>
        ) : null}
      </div>
      {state === 'throttled' || state === 'failed' ? (
        <p className="ac-note ac-warn" role="alert">
          <Icon name="info" />
          <span>{auth(`check.resend-${state}`)}</span>
        </p>
      ) : null}
      <div>
        <button className="btn" type="submit" disabled={state === 'pending'}>
          {t('send-new')}
        </button>
      </div>
    </form>
  );
}
