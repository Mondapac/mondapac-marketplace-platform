'use client';

import { Badge, Button, Select, useMediaQuery } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CustomerConsentHistory } from './customer-consent-history.tsx';
import { CustomerSignIns } from './customer-sign-ins.tsx';
import { dayOf, timeOf } from './format.ts';
import {
  ReadBody,
  RevealConfirm,
  RevealNote,
  RevealedTag,
  SectionFrame,
  deviceText,
  useRead,
  useReveals,
} from './security-shared.tsx';
import {
  ADDRESS_REVEAL,
  BEHAVIOUR_VIEW,
  CONSENT_VIEW,
  SESSION_END,
  SIGN_IN_VIEW,
  countryName,
  type AddressFull,
  type AddressSummary,
  type ConsentView,
  type PersonalizationView,
  type SessionsView,
} from './security-types.ts';

/** The open deletion request the page already read (the header banner's source). */
export interface DeletionRequestView {
  readonly requestId: string;
  readonly status: 'pending' | 'executing';
  readonly requestedAt: string;
  readonly scheduledFor: string;
}

type SectionId = 'sessions' | 'sign-ins' | 'addresses' | 'privacy' | 'deletion';
const SECTION_ORDER: readonly SectionId[] = [
  'sessions',
  'sign-ins',
  'addresses',
  'privacy',
  'deletion',
];

/**
 * The Account & security tab (customers management phase 2b, part B): one tab, five sections in
 * the order Active sessions, Sign-ins, Addresses, Privacy and Deletion request, each under its own
 * heading and key, each read on its own (a failure shows inside it with Retry; a 403 hides it and
 * its index entry). On desktop a sticky in-page index sits at the right; on phones it is a "Jump
 * to" select at the top. Nothing revealed here ever reaches a URL, storage, a saved view or a file.
 */
export function CustomerSecurity({
  accountId,
  adminAccountId,
  marketId,
  keys,
  csrfToken,
  zone,
  paging,
  deletion,
  deletionPending,
  sessionsVersion,
  onSignOut,
}: {
  readonly accountId: string;
  readonly adminAccountId: string;
  readonly marketId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly deletion: DeletionRequestView | null;
  /** A request was made or cancelled on this page, so `deletion` may be out of date. */
  readonly deletionPending: boolean;
  /** Changes when every session was ended (the sessions list reads again). */
  readonly sessionsVersion: number;
  readonly onSignOut: () => void;
}) {
  const t = useTranslations('customers.security');
  const desktop = useMediaQuery('(min-width: 64rem)');
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const hide = useCallback(
    (part: string) =>
      setGone((current) => (current.has(part) ? current : new Set(current).add(part))),
    [],
  );
  const hideSessions = useCallback(() => hide('sessions'), [hide]);
  const hideSignIns = useCallback(() => hide('sign-ins'), [hide]);
  const hideAddresses = useCallback(() => hide('addresses'), [hide]);
  const hideConsent = useCallback(() => hide('consent'), [hide]);
  const hideHistory = useCallback(() => hide('consent-history'), [hide]);
  const hidePersonalization = useCallback(() => hide('personalization'), [hide]);

  const privacyParts = [
    ...(keys.has(CONSENT_VIEW) ? ['consent', 'consent-history'] : []),
    ...(keys.has(BEHAVIOUR_VIEW) ? ['personalization'] : []),
  ];
  const shown: readonly SectionId[] = SECTION_ORDER.filter((id) => {
    if (id === 'sessions' || id === 'sign-ins') return keys.has(SIGN_IN_VIEW) && !gone.has(id);
    if (id === 'addresses') return !gone.has(id);
    if (id === 'privacy') return privacyParts.some((part) => !gone.has(part));
    return true;
  });

  /** Scrolls to a section; the desktop index also moves focus to its heading, the phone select does not. */
  function jump(id: string, focus: boolean) {
    const heading = document.getElementById(`security-${id}-title`);
    heading?.scrollIntoView?.({ block: 'start' });
    if (focus) heading?.focus();
    setCurrent(id);
  }

  // The index marks the section being read. jsdom and old browsers have no IntersectionObserver;
  // there the last clicked entry stands in.
  const shownKey = shown.join(',');
  useEffect(() => {
    if (!desktop || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.section ?? '';
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = shownKey.split(',').find((id) => visible.has(id));
        if (first !== undefined) setCurrent(first);
      },
      { rootMargin: '0px 0px -60% 0px' },
    );
    for (const id of shownKey.split(',')) {
      const node = document.getElementById(`security-${id}`);
      if (node !== null) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [desktop, shownKey]);

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      {shown.includes('sessions') ? (
        <SessionsSection
          accountId={accountId}
          keys={keys}
          zone={zone}
          version={sessionsVersion}
          onHidden={hideSessions}
          onSignOut={onSignOut}
        />
      ) : null}
      {shown.includes('sign-ins') ? (
        <SectionFrame id="sign-ins" title={t('section.sign-ins')}>
          <CustomerSignIns
            accountId={accountId}
            adminAccountId={adminAccountId}
            marketId={marketId}
            keys={keys}
            csrfToken={csrfToken}
            zone={zone}
            paging={paging}
            onHidden={hideSignIns}
          />
        </SectionFrame>
      ) : null}
      {shown.includes('addresses') ? (
        <AddressesSection
          accountId={accountId}
          keys={keys}
          csrfToken={csrfToken}
          zone={zone}
          onHidden={hideAddresses}
        />
      ) : null}
      {shown.includes('privacy') ? (
        <SectionFrame id="privacy" title={t('section.privacy')}>
          {keys.has(CONSENT_VIEW) && !gone.has('consent') ? (
            <ConsentBlock accountId={accountId} zone={zone} onHidden={hideConsent} />
          ) : null}
          {keys.has(BEHAVIOUR_VIEW) && !gone.has('personalization') ? (
            <PersonalizationBlock
              accountId={accountId}
              zone={zone}
              onHidden={hidePersonalization}
            />
          ) : null}
          {keys.has(CONSENT_VIEW) && !gone.has('consent-history') ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-semibold">{t('consent-history.title')}</h3>
              <CustomerConsentHistory
                accountId={accountId}
                adminAccountId={adminAccountId}
                marketId={marketId}
                keys={keys}
                csrfToken={csrfToken}
                zone={zone}
                paging={paging}
                onHidden={hideHistory}
              />
            </div>
          ) : null}
        </SectionFrame>
      ) : null}
      <DeletionSection deletion={deletion} pending={deletionPending} zone={zone} />
    </div>
  );

  return desktop ? (
    <div className="flex items-start gap-6">
      <nav
        aria-label={t('index.label')}
        className="sticky top-4 order-last w-52 shrink-0 self-start"
      >
        <p className="mb-2 text-sm font-medium text-fg-secondary">{t('index.label')}</p>
        <ul className="flex flex-col gap-1 border-s border-line ps-3">
          {shown.map((id) => (
            <li key={id}>
              <a
                href={`#security-${id}`}
                aria-current={current === id ? 'location' : undefined}
                className="block py-1 text-sm text-fg-secondary hover:text-fg aria-[current=location]:font-medium aria-[current=location]:text-fg"
                onClick={(event) => {
                  event.preventDefault();
                  jump(id, true);
                }}
              >
                {t(`section.${id}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </div>
  ) : (
    <div className="flex flex-col gap-4">
      <Select
        label={t('jump.label')}
        placeholder={t('jump.placeholder')}
        value=""
        options={shown.map((id) => ({ value: id, label: t(`section.${id}`) }))}
        onChange={(event) => {
          // Scroll only: focus stays on the select, which goes back to its placeholder.
          const value = event.target.value;
          if (value !== '') jump(value, false);
        }}
      />
      {body}
    </div>
  );
}

/** Active sessions (identity): device, rough place, started, last seen, and "Sign out everywhere…". */
function SessionsSection({
  accountId,
  keys,
  zone,
  version,
  onHidden,
  onSignOut,
}: {
  readonly accountId: string;
  readonly keys: ReadonlySet<string>;
  readonly zone: string;
  readonly version: number;
  readonly onHidden: () => void;
  readonly onSignOut: () => void;
}) {
  const t = useTranslations('customers.security');
  const locale = useLocale();
  const id = encodeURIComponent(accountId);
  const { read, retry } = useRead<SessionsView>(
    () => callApi<SessionsView>('GET', `customers/admin/customers/${id}/sessions`),
    { version, onHidden },
  );
  if (read.state === 'hidden') return null;
  const ready = read.state === 'ready' ? read.body : null;
  const noSessions = ready !== null && ready.items.length === 0;
  return (
    <SectionFrame
      id="sessions"
      title={t('section.sessions')}
      actions={
        keys.has(SESSION_END) ? (
          <div className="flex flex-wrap items-center gap-2">
            {noSessions ? (
              <span id="security-sessions-none" className="text-sm text-fg-muted">
                {t('sessions.sign-out-none')}
              </span>
            ) : null}
            <Button
              variant="secondary"
              disabled={noSessions}
              aria-describedby={noSessions ? 'security-sessions-none' : undefined}
              onClick={onSignOut}
            >
              {t('sessions.sign-out')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <ReadBody read={read} retry={retry} label={t('section.sessions')}>
        {(body) =>
          body.items.length === 0 ? (
            <p className="text-fg-muted">{t('sessions.empty')}</p>
          ) : (
            <>
              <ul
                aria-label={t('section.sessions')}
                className="flex flex-col divide-y divide-line-row"
              >
                {body.items.map((session, index) => (
                  <li
                    key={`${session.signedInAt}-${index}`}
                    className="flex flex-col gap-0.5 py-2.5 first:pt-0"
                  >
                    <span className="font-medium">{deviceText(session.device, t)}</span>
                    <span className="text-sm text-fg-muted">
                      {t('sessions.started', { time: timeOf(session.signedInAt, locale, zone) })}
                      {' · '}
                      {t('sessions.last-seen', {
                        time: timeOf(session.lastActiveAt, locale, zone),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              {body.more ? <p className="text-sm text-fg-muted">{t('sessions.more')}</p> : null}
            </>
          )
        }
      </ReadBody>
    </SectionFrame>
  );
}

type AddressField = 'recipient' | 'phone' | 'lines' | 'place' | 'notes';

/** Addresses (customers): suburb and country; "Show full address…" per address, recorded. */
function AddressesSection({
  accountId,
  keys,
  csrfToken,
  zone,
  onHidden,
}: {
  readonly accountId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  readonly onHidden: () => void;
}) {
  const t = useTranslations('customers.security');
  const locale = useLocale();
  const id = encodeURIComponent(accountId);
  const [target, setTarget] = useState<string | null>(null);
  const reveals = useReveals<AddressFull>(t('reveal.hidden-address'));
  const { read, retry } = useRead<{ readonly items: readonly AddressSummary[] }>(
    () => callApi('GET', `customers/admin/customers/${id}/addresses`),
    { onHidden },
  );
  if (read.state === 'hidden') return null;
  const canReveal = keys.has(ADDRESS_REVEAL);
  return (
    <SectionFrame id="addresses" title={t('section.addresses')}>
      <ReadBody read={read} retry={retry} label={t('section.addresses')}>
        {(body) =>
          body.items.length === 0 ? (
            <p className="text-fg-muted">{t('addresses.empty')}</p>
          ) : (
            <ul
              aria-label={t('section.addresses')}
              className="flex flex-col divide-y divide-line-row"
            >
              {body.items.map((address) => {
                const full = reveals.shown.get(address.addressId);
                const place =
                  address.suburb === null
                    ? t('addresses.erased')
                    : `${address.suburb}, ${countryName(address.countryCode, locale)}`;
                return (
                  <li key={address.addressId} className="flex flex-col gap-2 py-3 first:pt-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="flex flex-wrap items-center gap-2 font-medium wrap-anywhere">
                          {place}
                          {address.isDefault ? (
                            <Badge tone="neutral">{t('addresses.default')}</Badge>
                          ) : null}
                        </span>
                        <span className="text-sm text-fg-muted">
                          {t('addresses.added', { date: dayOf(address.createdAt, locale, zone) })}
                        </span>
                      </div>
                      {canReveal && address.suburb !== null ? (
                        full === undefined ? (
                          <Button
                            variant="secondary"
                            onClick={() => setTarget(address.addressId)}
                            aria-label={t('addresses.show-for', { place })}
                          >
                            {t('addresses.show')}
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={() => reveals.hide(address.addressId)}
                            aria-label={t('addresses.hide-for', { place })}
                          >
                            {t('addresses.hide')}
                          </Button>
                        )
                      ) : null}
                    </div>
                    {full === undefined ? null : (
                      <div className="flex flex-col gap-2 rounded-md bg-surface-sunken p-3">
                        <RevealedTag />
                        <FullAddress address={full} locale={locale} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </ReadBody>
      <RevealNote note={reveals.note} />
      <RevealConfirm<AddressFull>
        target={target}
        title={t('addresses.reveal.title')}
        body={t('addresses.reveal.body')}
        confirmLabel={t('addresses.reveal.confirm')}
        run={(addressId) =>
          callApi<AddressFull>(
            'POST',
            `customers/admin/customers/${id}/addresses/${encodeURIComponent(addressId)}/reveal`,
            {},
            csrfToken,
          )
        }
        onRevealed={(addressId, value) => {
          reveals.show(addressId, value);
          setTarget(null);
        }}
        onCancel={() => setTarget(null)}
      />
    </SectionFrame>
  );
}

function FullAddress({
  address,
  locale,
}: {
  readonly address: AddressFull;
  readonly locale: string;
}) {
  const t = useTranslations('customers.security.addresses.field');
  const rows: readonly (readonly [AddressField, string])[] = [
    ['recipient', `${address.recipientFirstName} ${address.recipientLastName}`],
    ['phone', address.phone],
    ['lines', [address.line1, address.line2].filter(Boolean).join(', ')],
    [
      'place',
      [
        [address.suburb, address.region, address.postcode].filter(Boolean).join(' '),
        countryName(address.countryCode, locale),
      ].join(', '),
    ],
    ...(address.deliveryNotes === null ? [] : [['notes', address.deliveryNotes] as const]),
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-fg-muted">{t(key)}</dt>
          <dd className="wrap-anywhere">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Marketing consent (legal): the current state per channel. Read only. */
function ConsentBlock({
  accountId,
  zone,
  onHidden,
}: {
  readonly accountId: string;
  readonly zone: string;
  readonly onHidden: () => void;
}) {
  const t = useTranslations('customers.security');
  const locale = useLocale();
  const id = encodeURIComponent(accountId);
  const { read, retry } = useRead<ConsentView>(
    () => callApi<ConsentView>('GET', `customers/admin/customers/${id}/consent`),
    { onHidden },
  );
  if (read.state === 'hidden') return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">{t('consent.title')}</h3>
      <ReadBody read={read} retry={retry} label={t('consent.title')}>
        {(body) =>
          body.channels.length === 0 ? (
            <p className="text-fg-muted">{t('consent.empty')}</p>
          ) : (
            <ul aria-label={t('consent.title')} className="flex flex-col divide-y divide-line-row">
              {body.channels.map((state) => (
                <li
                  key={state.channel}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {state.channel === 'email' ? t('channel.email') : state.channel}
                    </span>
                    <span className="text-sm text-fg-muted">
                      {state.changedAt === null
                        ? t('consent.never')
                        : t('consent.changed', { time: timeOf(state.changedAt, locale, zone) })}
                    </span>
                  </span>
                  <Badge tone={state.granted ? 'success' : 'neutral'}>
                    {state.granted ? t('consent.granted') : t('consent.not-granted')}
                  </Badge>
                </li>
              ))}
            </ul>
          )
        }
      </ReadBody>
    </div>
  );
}

/** The personalisation switch (engagement), read from the behaviour answer: counts are not shown here. */
function PersonalizationBlock({
  accountId,
  zone,
  onHidden,
}: {
  readonly accountId: string;
  readonly zone: string;
  readonly onHidden: () => void;
}) {
  const t = useTranslations('customers.security');
  const locale = useLocale();
  const id = encodeURIComponent(accountId);
  const { read, retry } = useRead<PersonalizationView>(
    () => callApi<PersonalizationView>('GET', `customers/admin/customers/${id}/behaviour`),
    { onHidden },
  );
  if (read.state === 'hidden') return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">{t('personalization.title')}</h3>
      <ReadBody read={read} retry={retry} label={t('personalization.title')}>
        {(body) => (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-fg-muted">
              {body.personalization.changedAt === null
                ? t('personalization.never')
                : t('personalization.changed', {
                    time: timeOf(body.personalization.changedAt, locale, zone),
                  })}
            </span>
            <Badge tone={body.personalization.enabled ? 'success' : 'neutral'}>
              {body.personalization.enabled ? t('personalization.on') : t('personalization.off')}
            </Badge>
          </div>
        )}
      </ReadBody>
    </div>
  );
}

/**
 * Deletion request: the open request the page already read (the header banner stays on every
 * tab). The API lists only the Market's pending requests, never one customer's past ones, so
 * only the current request can be shown.
 */
function DeletionSection({
  deletion,
  pending,
  zone,
}: {
  readonly deletion: DeletionRequestView | null;
  readonly pending: boolean;
  readonly zone: string;
}) {
  const t = useTranslations('customers.security');
  const locale = useLocale();
  return (
    <SectionFrame id="deletion" title={t('section.deletion')}>
      {deletion === null ? (
        <p className={pending ? '' : 'text-fg-muted'}>
          {pending ? t('deletion.pending-banner') : t('deletion.none')}
        </p>
      ) : deletion.status === 'executing' ? (
        <p>{t('deletion.executing', { date: dayOf(deletion.requestedAt, locale, zone) })}</p>
      ) : (
        <p>
          {t('deletion.pending', {
            requested: dayOf(deletion.requestedAt, locale, zone),
            scheduled: dayOf(deletion.scheduledFor, locale, zone),
          })}
        </p>
      )}
    </SectionFrame>
  );
}
