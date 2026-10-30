'use client';

import {
  ActionRow,
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  TextField,
  toast,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { useThrottle } from '../auth/use-throttle.ts';
import { formatInstant, known } from '../catalog/format.ts';
import { payoutProblemOf, type PayoutProblem } from './errors.ts';
import {
  CHANGE_KINDS,
  STATUSES,
  type PayoutAccount,
  type PayoutLink,
  type StripeReturn,
} from './types.ts';

const TONE: Record<string, BadgeTone> = {
  'not-connected': 'neutral',
  'not-started': 'neutral',
  pending: 'attention',
  enabled: 'success',
  restricted: 'attention',
  rejected: 'critical',
};

/** Where the seller is sent: only the Stripe address the API returned, as an https address. */
function stripeAddress(body: PayoutLink | null): string | null {
  return typeof body?.url === 'string' && body.url.startsWith('https://') ? body.url : null;
}

/**
 * The payout account of the Seller Owner (Stripe Connect): status, waiting period, recent
 * changes and the one action that opens Stripe. The action asks for a code from the
 * authenticator app (or a recovery code) first. The Stripe address is used once and never kept.
 */
export function PayoutAccountView({
  initial,
  csrfToken,
  canManage,
  back,
}: {
  readonly initial: PayoutAccount;
  readonly csrfToken: string;
  readonly canManage: boolean;
  readonly back: StripeReturn;
}) {
  const t = useTranslations('payout');
  const locale = useLocale();
  const zone = useTimeZone();
  const [account, setAccount] = useState(initial);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<PayoutProblem | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const busy = useRef(false);
  const throttle = useThrottle();

  const status = known(account.status, STATUSES);
  const connected = status !== 'not-connected';
  const coolingOff =
    account.coolingOffUntil !== null && new Date(account.coolingOffUntil).getTime() > Date.now();
  const actionKey =
    status === 'not-connected'
      ? 'connect'
      : status === 'enabled' || status === 'rejected'
        ? 'review'
        : 'continue';

  function close() {
    if (pending) return;
    setOpen(false);
    setCode('');
    setProblem(null);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy.current || throttle.blocked) return;
    const clean = code.replace(/[\s-]/g, '');
    if (clean === '') {
      setProblem({ key: 'code-required' });
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<PayoutLink>(
      'POST',
      connected ? 'payments/seller/payout-account/link' : 'payments/seller/payout-account',
      { code: clean },
      csrfToken,
    );
    if (result.ok) {
      const url = stripeAddress(result.body);
      if (url !== null) {
        // Leave this page for Stripe; the address is not stored or logged. The button stays busy.
        window.location.assign(url);
        return;
      }
      busy.current = false;
      setPending(false);
      setProblem({ key: 'unavailable' });
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const failure = payoutProblemOf(result.failure);
    // A wrong or locked code is not kept; a network or server failure keeps what was typed.
    if (failure.key === 'invalid' || failure.key === 'locked') setCode('');
    if (failure.key === 'locked') throttle.start((failure.minutes ?? 1) * 60);
    setProblem(failure);
  }

  async function check() {
    setChecking(true);
    setCheckFailed(false);
    const result = await callApi<PayoutAccount>('GET', 'payments/seller/payout-account');
    setChecking(false);
    if (result.ok) {
      setAccount(result.body);
      toast.success(t('checked'));
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setCheckFailed(true);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {back === 'return' ? (
        <Banner tone="info" title={t('back.return.title')}>
          {t('back.return.body')}
        </Banner>
      ) : null}
      {back === 'refresh' ? (
        <Banner tone="attention" title={t('back.refresh.title')}>
          {t('back.refresh.body')}
        </Banner>
      ) : null}
      <Card title={t('status.title')}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
          {connected && !coolingOff ? (
            <Badge tone={account.ready ? 'success' : 'neutral'}>
              {t(account.ready ? 'ready.yes' : 'ready.no')}
            </Badge>
          ) : null}
        </div>
        <p className="text-fg-secondary">
          {t(`status.about.${status === 'enabled' && coolingOff ? 'waiting' : status}`)}
        </p>
        {connected ? (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-fg-muted">{t('field.requirements')}</dt>
              <dd className="font-medium">
                {account.requirementsDue === 0
                  ? t('requirements.none')
                  : t('requirements.due', { count: account.requirementsDue })}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-fg-muted">{t('field.past-due')}</dt>
              <dd className="font-medium">{t(account.requirementsPastDue ? 'yes' : 'no')}</dd>
            </div>
          </dl>
        ) : null}
        {account.requirementsPastDue ? <Banner tone="critical">{t('past-due')}</Banner> : null}
        {coolingOff && account.coolingOffUntil !== null ? (
          <Banner tone="attention" title={t('cooling-off.title')}>
            {t('cooling-off.body', { until: formatInstant(account.coolingOffUntil, locale, zone) })}
            {account.payoutsPaused ? ` ${t('cooling-off.paused')}` : ''}
          </Banner>
        ) : null}
        {!coolingOff && account.payoutsPaused ? (
          <Banner tone="attention">{t('cooling-off.paused')}</Banner>
        ) : null}
        {canManage ? (
          account.secondFactorActive ? (
            <ActionRow>
              <Button type="button" onClick={() => setOpen(true)}>
                {t(`action.${actionKey}`)}
              </Button>
              {connected ? (
                <Button
                  type="button"
                  variant="secondary"
                  loading={checking}
                  onClick={() => void check()}
                >
                  {t('action.check')}
                </Button>
              ) : null}
            </ActionRow>
          ) : (
            <Banner tone="info" title={t('second-factor.title')}>
              <p>{t('second-factor.body')}</p>
              <a
                href="/account/security"
                className="inline-flex min-h-12 items-center font-medium text-link underline"
              >
                {t('second-factor.link')}
              </a>
            </Banner>
          )
        ) : null}
        {checkFailed ? <Banner tone="critical">{t('error.check')}</Banner> : null}
      </Card>
      <Card title={t('changes.title')}>
        {account.changes.length === 0 ? (
          <p className="text-fg-muted">{t('changes.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-row">
            {account.changes.map((change) => (
              <li
                key={`${change.detectedAt}-${change.kind}`}
                className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[minmax(0,var(--mp-size-data-label))_minmax(0,1fr)] sm:gap-x-6"
              >
                <span className="text-fg-muted">
                  {formatInstant(change.detectedAt, locale, zone)}
                </span>
                <span className="font-medium">
                  {t(`changes.kind.${known(change.kind, CHANGE_KINDS)}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog
        open={open}
        title={t('dialog.title')}
        onClose={close}
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={pending}>
              {t('dialog.cancel')}
            </Button>
            <Button loading={pending} disabled={throttle.blocked} onClick={() => void submit()}>
              {t('dialog.continue')}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="flex max-w-(--mp-size-form-max) flex-col gap-4"
        >
          <p>{t('dialog.body')}</p>
          {problem ? (
            <Banner tone="critical">
              {t(`error.${problem.key}`, { minutes: problem.minutes ?? 1 })}
            </Banner>
          ) : null}
          <TextField
            label={t('dialog.label')}
            name="code"
            autoComplete="one-time-code"
            inputMode="text"
            dir="ltr"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            help={t('dialog.help')}
          />
        </form>
      </Dialog>
    </div>
  );
}
