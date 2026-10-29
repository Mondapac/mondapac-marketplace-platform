'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { intlLocale } from '../i18n/locale.ts';
import { Icon } from '../icons/icon.tsx';
import { AccountFrame } from './account-area.tsx';
import { useAccount } from './account-state.tsx';
import * as api from './customer-api.ts';

// Account deletion on the buyer site (customers package 5a and 5b; Reza's screens review, 29 Oct
// 2026). The API is the only source of truth: `canDeleteAccount` is the one switch, the waiting
// period is the API's, and the blockers are shown only from the 409 of the request. The Market
// setting is Off by default, so a buyer sees only a line pointing to support until it is turned on.
// There is no customer one-time code, sign-in does not cancel and no email is sent (notes.md, 5b):
// nothing here promises any of those.

type Phase = 'loading' | 'ready';

/** How a cancel ended; the notice words each one. */
export type CancelOutcome = 'cancelled' | 'in-progress' | 'retry' | 'failed';

export interface Deletion {
  readonly phase: Phase;
  /** The Market allows deletion now. A read that failed counts as no (fail closed). */
  readonly canDelete: boolean;
  readonly days: number | null;
  /** The open request (waiting or being carried out), or null. */
  readonly request: api.DeletionRequest | null;
  /** The buyer cancelled a request on this page; the notice stays until they leave. */
  readonly cancelled: boolean;
  readonly setRequest: (request: api.DeletionRequest | null) => void;
  readonly reload: () => Promise<void>;
  readonly cancel: () => Promise<CancelOutcome>;
}

/**
 * Reads the Market's switch and the buyer's open request once when the page opens. Sample mode
 * makes no request and counts as Off.
 */
export function useDeletion(live: boolean): Deletion {
  const [phase, setPhase] = useState<Phase>(live ? 'loading' : 'ready');
  const [canDelete, setCanDelete] = useState(false);
  const [days, setDays] = useState<number | null>(null);
  const [request, setRequest] = useState<api.DeletionRequest | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const read = useCallback(async () => {
    const [availability, current] = await Promise.all([
      api.readDeletionAvailability(),
      api.readDeletionRequest(),
    ]);
    if (availability.kind === 'ok') {
      setCanDelete(availability.value.canDeleteAccount);
      setDays(availability.value.waitingPeriodDays);
    } else {
      setCanDelete(false);
    }
    setRequest(current.kind === 'ok' ? current.value : null);
    setPhase('ready');
  }, []);

  useEffect(() => {
    if (!live) return;
    void read();
  }, [live, read]);

  const cancel = useCallback(async (): Promise<CancelOutcome> => {
    const result = await api.cancelDeletion();
    if (result.kind === 'ok') {
      setRequest(null);
      setCancelled(true);
      return 'cancelled';
    }
    if (result.kind === 'invalid' && result.code === 'customers.account-deletion-in-progress') {
      setRequest((open) => (open ? { ...open, status: 'executing' } : open));
      return 'in-progress';
    }
    if (
      result.kind === 'invalid' &&
      result.code === 'customers.account-deletion-request-not-found'
    ) {
      // Cancelled elsewhere or just carried out: show what the API says now.
      await read();
      return 'retry';
    }
    if (result.kind === 'invalid' && result.code === 'customers.conflict') return 'retry';
    return 'failed';
  }, [read]);

  return { phase, canDelete, days, request, cancelled, setRequest, reload: read, cancel };
}

/** A UTC instant as a calendar date in the buyer's own time zone (the browser's). */
function dateOf(instant: string, locale: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'long' }).format(
    new Date(instant),
  );
}

/**
 * The open request: the date, and while it is still waiting the Cancel button. After a cancel
 * the outcome is read out; `focusOnShow` moves focus to the notice (after a new request).
 */
export function PendingNotice({
  deletion,
  focusOnShow = false,
}: {
  readonly deletion: Deletion;
  readonly focusOnShow?: boolean;
}) {
  const t = useTranslations('account.delete');
  const locale = useLocale();
  const { request } = deletion;
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'retry' | 'failed' | null>(null);
  useEffect(() => {
    if (focusOnShow) box.current?.focus();
  }, [focusOnShow]);
  if (!request) return null;
  const executing = request.status === 'executing';
  return (
    <div className="ac-del">
      <div ref={box} className="ac-note ac-warn" role="status" tabIndex={-1}>
        <Icon name="info" />
        <span>
          {executing ? (
            <b>{t('executing')}</b>
          ) : (
            <>
              <b>{t('pending', { date: dateOf(request.scheduledFor, locale) })}</b>{' '}
              {t('pending-cancel')}
            </>
          )}
        </span>
      </div>
      {problem ? (
        <p className="ac-note ac-bad" role="alert">
          <Icon name="warn" />
          <span>{t(problem === 'retry' ? 'cancel-retry' : 'cancel-failed')}</span>
        </p>
      ) : null}
      {executing ? null : (
        <div className="ac-acts">
          <button
            className="btn ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              void deletion
                .cancel()
                .then((outcome) => {
                  if (outcome === 'retry' || outcome === 'failed') setProblem(outcome);
                })
                .finally(() => setBusy(false));
            }}
          >
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

/** The cancelled notice (a status, so it is read out). */
export function CancelledNotice() {
  const t = useTranslations('account.delete');
  return (
    <p className="ac-note" role="status">
      <Icon name="check" />
      <span>{t('cancelled')}</span>
    </p>
  );
}

/**
 * The deletion entry of the Privacy card. Off, unknown or sample: one muted line to support.
 * On: the row with the link to the delete page. An open request shows its notice instead.
 */
export function DeletionEntry({ deletion }: { readonly deletion: Deletion }) {
  const t = useTranslations('account.delete');
  const footer = useTranslations('footer');
  const settings = useTranslations('account.settings');
  if (deletion.phase === 'loading')
    return (
      <div className="ac-del" role="status" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <div className="skel line" aria-hidden="true" />
      </div>
    );
  if (deletion.request) return <PendingNotice deletion={deletion} />;
  if (deletion.canDelete && deletion.days !== null)
    return (
      <div className="ac-del">
        {deletion.cancelled ? <CancelledNotice /> : null}
        <div className="ac-tg">
          <div>
            <b>{settings('delete-account')}</b>
            <small>{t('summary', { days: deletion.days })}</small>
          </div>
          <Link className="btn ghost ac-danger" href="/account/delete">
            {settings('delete-account')}
          </Link>
        </div>
      </div>
    );
  return (
    <div className="ac-del">
      {deletion.cancelled ? <CancelledNotice /> : null}
      <p className="ac-sub">
        {t('support-hint')} <a href={`mailto:${footer('email')}`}>{footer('email')}</a>
      </p>
    </div>
  );
}

type Problem = 'failed' | 'unavailable' | null;

/** `/account/delete`: what is removed and what stays, one confirmation, then the pending state. */
export function AccountDeleteScreen() {
  const t = useTranslations('account.delete');
  const title = t('title');
  const { source } = useAccount();
  const router = useRouter();
  const deletion = useDeletion(source.live);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<readonly api.DeletionBlocker[] | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [fresh, setFresh] = useState(false);
  const blocked = useRef<HTMLDivElement>(null);
  const checkId = useId();

  const { phase, canDelete, request, cancelled } = deletion;
  // With the setting Off and nothing open there is nothing to do here. An open request still
  // shows, so the buyer can cancel it even after the setting went Off.
  const leaves = phase === 'ready' && !canDelete && !request && !cancelled;
  useEffect(() => {
    if (leaves) router.replace('/account/settings');
  }, [leaves, router]);
  useEffect(() => {
    if (blockers !== null) blocked.current?.focus();
  }, [blockers]);

  const back = { href: '/account/settings', key: 'settings' } as const;
  const toSettings = (
    <Link className="btn ghost" href="/account/settings">
      {t('back')}
    </Link>
  );

  if (phase === 'loading' || leaves)
    return (
      <AccountFrame title={title} back={back}>
        <section className="ac-card" role="status" aria-busy="true">
          <span className="sr-only">{t('loading')}</span>
          <div className="skel line" aria-hidden="true" />
          <div className="skel line" aria-hidden="true" />
        </section>
      </AccountFrame>
    );

  if (request || cancelled)
    return (
      <AccountFrame title={title} back={back}>
        <section className="ac-card" aria-labelledby="delete-state">
          <h2 id="delete-state">{t('state-title')}</h2>
          {cancelled ? (
            <CancelledNotice />
          ) : (
            <PendingNotice deletion={deletion} focusOnShow={fresh} />
          )}
          <div className="ac-acts">{toSettings}</div>
        </section>
      </AccountFrame>
    );

  if (problem === 'unavailable')
    return (
      <AccountFrame title={title} back={back}>
        <section className="ac-card">
          <p role="status">{t('unavailable')}</p>
          <div className="ac-acts">{toSettings}</div>
        </section>
      </AccountFrame>
    );

  const submit = () => {
    setBusy(true);
    setProblem(null);
    void api
      .requestDeletion()
      .then(async (result) => {
        if (result.kind === 'ok') {
          setFresh(true);
          deletion.setRequest(result.value);
          return;
        }
        if (result.kind === 'invalid') {
          if (result.code === 'customers.account-deletion-disabled')
            return setProblem('unavailable');
          if (result.code === 'customers.account-deletion-blocked')
            return setBlockers(api.blockersOf(result.details));
          if (result.code === 'customers.account-deletion-already-requested')
            return deletion.reload();
        }
        setProblem('failed');
      })
      .finally(() => setBusy(false));
  };

  return (
    <AccountFrame title={title} back={back}>
      <section className="ac-card ac-del" aria-labelledby="delete-what">
        <p>{t('intro', { days: deletion.days ?? 0 })}</p>
        <h2 id="delete-what">{t('removed-title')}</h2>
        <ul className="ac-list">
          {(['name', 'email', 'phone', 'addresses', 'saved'] as const).map((key) => (
            <li key={key}>{t(`removed-${key}`)}</li>
          ))}
        </ul>
        <h2>{t('stays-title')}</h2>
        <ul className="ac-list">
          <li>{t('stays-orders')}</li>
          <li>{t('stays-reviews')}</li>
        </ul>
        <p className="ac-note">
          <Icon name="info" />
          <span>{t('other-devices')}</span>
        </p>
        <label className="ac-check" htmlFor={checkId}>
          <input
            id={checkId}
            type="checkbox"
            checked={understood}
            onChange={(event) => setUnderstood(event.target.checked)}
          />
          <span>{t('understand')}</span>
        </label>
        {blockers !== null ? (
          <div ref={blocked} className="ac-note ac-bad" role="alert" tabIndex={-1}>
            <Icon name="warn" />
            <div>
              <b>{t('blocked')}</b>
              <ul className="ac-list">
                {blockers.map((blocker) => (
                  <li key={blocker.code}>
                    {blocker.code === 'wallet-balance' ? (
                      t('blocked-wallet')
                    ) : (
                      <>
                        {t(blocker.code === 'open-orders' ? 'blocked-orders' : 'blocked-refunds', {
                          count: blocker.count ?? 0,
                        })}{' '}
                        <Link href="/account/orders">{t('view-orders')}</Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {problem === 'failed' ? (
          <p className="ac-note ac-bad" role="alert">
            <Icon name="warn" />
            <span>{t('failed')}</span>
          </p>
        ) : null}
        <div className="ac-acts">
          <button
            className="btn ac-danger-fill"
            type="button"
            aria-describedby={checkId}
            disabled={!understood || busy || blockers !== null}
            onClick={submit}
          >
            {t('confirm')}
          </button>
          {toSettings}
        </div>
      </section>
    </AccountFrame>
  );
}
