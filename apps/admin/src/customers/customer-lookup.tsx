'use client';

import {
  ActionRow,
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  FieldAction,
  LinkButton,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { BuyerDeletion } from '../account-deletion/buyer-deletion.tsx';
import { callApi, type ApiFailure } from '../api/client.ts';
import { useCountdown } from '../api/use-countdown.ts';
import { formatInstant } from '../shared/format.ts';
import { customerProblemOf } from './errors.ts';
import { EMAIL_MAX, type CustomerAccount } from './types.ts';

type Problem = { readonly key: string; readonly retryAfter?: number };

/** A problem from a failed call; the session-ended case navigates away and answers null. */
function problemOf(failure: ApiFailure): Problem | null {
  if (failure.status === 401) {
    window.location.assign('/session-ended');
    return null;
  }
  const key = customerProblemOf(failure);
  const seconds = failure.details?.retryAfterSeconds;
  return key === 'throttled' && typeof seconds === 'number' && seconds > 0
    ? { key, retryAfter: Math.ceil(seconds) }
    : { key };
}

/**
 * Finds one customer account by its exact sign-in address (identity slice 8d) and, for an actor
 * who may, disables or enables it (slice 8c). No partial search: the API matches the address as
 * normalised at sign-in. The address goes in a POST body, never a URL.
 */
export function CustomerLookup({
  canChangeStatus,
  walletLink = null,
  buyerDeletion = null,
  csrfToken,
}: {
  readonly canChangeStatus: boolean;
  /** The wallet link on a found account: issue credit (wallet.credit.issue) or view (credit.view). */
  readonly walletLink?: 'issue' | 'view' | null;
  /**
   * The delete-account action on a found account (customers.buyer-account.delete); null hides
   * it. `waitingPeriodDays` is the Market's setting when the actor may read it, else null.
   */
  readonly buyerDeletion?: { readonly waitingPeriodDays: number | null } | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations('customers');
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [changing, setChanging] = useState(false);
  const [changeProblem, setChangeProblem] = useState<Problem | null>(null);
  const [wait, setWait] = useCountdown();
  const busy = useRef(false);

  async function find(event: FormEvent) {
    event.preventDefault();
    if (busy.current || wait > 0) return;
    const address = email.trim();
    setProblem(null);
    setChangeProblem(null);
    if (address === '' || address.length > EMAIL_MAX || !address.includes('@')) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    busy.current = true;
    setPending(true);
    const result = await callApi<CustomerAccount>(
      'POST',
      'identity/admin/customers/lookup',
      { email: address },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setCustomer(result.body);
      return;
    }
    setCustomer(null);
    const next = problemOf(result.failure);
    if (next === null) return;
    if (next.key === 'invalid') setInvalid(true);
    else setProblem(next);
    if (next.retryAfter !== undefined) setWait(next.retryAfter);
  }

  async function changeStatus() {
    if (customer === null || busy.current) return;
    const action = customer.status === 'active' ? 'disable' : 'enable';
    busy.current = true;
    setChanging(true);
    setChangeProblem(null);
    const result = await callApi<{ code: string; accountId: string }>(
      'POST',
      `identity/admin/customers/${customer.accountId}/${action}`,
      {},
      csrfToken,
    );
    busy.current = false;
    setChanging(false);
    setConfirming(false);
    if (result.ok) {
      const status = action === 'disable' ? 'disabled' : 'active';
      setCustomer({ ...customer, status });
      toast.success(t(action === 'disable' ? 'changed.disabled' : 'changed.enabled'));
      return;
    }
    const next = problemOf(result.failure);
    if (next !== null) setChangeProblem(next);
  }

  const active = customer?.status === 'active';
  const rows =
    customer === null
      ? []
      : [
          { label: t('field.email'), value: customer.email },
          {
            label: t('field.email-verified'),
            value: t(customer.emailVerified ? 'yes' : 'no'),
          },
          { label: t('field.created'), value: formatInstant(customer.createdAt, locale) },
        ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <form
        className="flex max-w-(--mp-size-form-max) flex-col gap-3 sm:flex-row sm:items-start"
        onSubmit={(event) => void find(event)}
        noValidate
        role="search"
      >
        <div className="min-w-0 flex-1">
          <TextField
            name="email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            maxLength={EMAIL_MAX}
            label={t('field.lookup')}
            help={t('field.lookup-help')}
            value={email}
            error={invalid ? t('error.invalid') : undefined}
            onChange={(event) => {
              setEmail(event.target.value);
              // The card always belongs to the address in the field: a new address clears it.
              setCustomer(null);
              setChangeProblem(null);
            }}
          />
        </div>
        <FieldAction>
          <Button type="submit" loading={pending} disabled={wait > 0}>
            {t('find')}
          </Button>
        </FieldAction>
      </form>
      {problem === null ? null : problem.key === 'not-found' ? (
        <Banner tone="info" title={t('not-found.title')}>
          {t('not-found.body')}
        </Banner>
      ) : problem.key === 'throttled' ? (
        <Banner tone="attention">
          {wait > 0 ? t('error.throttled-wait', { seconds: wait }) : t('error.throttled')}
        </Banner>
      ) : (
        <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
      )}
      {customer === null ? null : (
        <Card title={t('result.title')}>
          <div>
            <Badge tone={active ? 'success' : 'critical'}>{t(`status.${customer.status}`)}</Badge>
          </div>
          {changeProblem === null ? null : (
            <Banner tone={changeProblem.key === 'throttled' ? 'attention' : 'critical'}>
              {t(`error.${changeProblem.key}`)}
            </Banner>
          )}
          <dl className="flex flex-col gap-3 sm:grid sm:grid-cols-[max-content_1fr] sm:gap-x-6">
            {rows.map((row) => (
              <div key={row.label} className="flex flex-col sm:contents">
                <dt className="text-fg-muted">{row.label}</dt>
                <dd className="font-medium wrap-anywhere">{row.value}</dd>
              </div>
            ))}
          </dl>
          {canChangeStatus || walletLink !== null ? (
            <ActionRow>
              {walletLink === null ? null : (
                <LinkButton
                  variant="secondary"
                  href={`/wallet/credits?customer=${encodeURIComponent(customer.accountId)}`}
                >
                  {t(walletLink === 'issue' ? 'wallet-issue' : 'wallet-view')}
                </LinkButton>
              )}
              {canChangeStatus ? (
                <Button
                  variant={active ? 'destructive' : 'secondary'}
                  onClick={() => {
                    setChangeProblem(null);
                    setConfirming(true);
                  }}
                >
                  {t(active ? 'disable.action' : 'enable.action')}
                </Button>
              ) : null}
            </ActionRow>
          ) : null}
          {buyerDeletion === null ? null : (
            <BuyerDeletion
              key={customer.accountId}
              accountId={customer.accountId}
              waitingPeriodDays={buyerDeletion.waitingPeriodDays}
              csrfToken={csrfToken}
            />
          )}
        </Card>
      )}
      <Dialog
        open={confirming}
        title={t(active ? 'disable.title' : 'enable.title')}
        onClose={() => {
          if (!changing) setConfirming(false);
        }}
        actions={
          <>
            <Button variant="secondary" disabled={changing} onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant={active ? 'destructive' : 'primary'}
              loading={changing}
              onClick={() => void changeStatus()}
            >
              {t(active ? 'disable.confirm' : 'enable.confirm')}
            </Button>
          </>
        }
      >
        <p className="wrap-anywhere">
          {t(active ? 'disable.body' : 'enable.body', { email: customer?.email ?? '' })}
        </p>
      </Dialog>
    </div>
  );
}
