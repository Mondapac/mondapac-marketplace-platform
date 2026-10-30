'use client';

import {
  ActionRow,
  Badge,
  Banner,
  Button,
  Card,
  DataList,
  LinkButton,
  LoadError,
  Select,
  SkeletonRows,
  TextAreaField,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { failedFields, isDefiniteRefusal, walletProblemOf } from './errors.ts';
import { wordFor } from './labels.ts';
import { decimalsOf, exampleAmount, formatMinor, isMore, parseAmount, sumMinor } from './money.ts';
import { MoneyField } from './money-field.tsx';
import {
  CREDIT_REASONS,
  NOTE_MAX,
  WALLET_STATES,
  type AdminCredit,
  type CustomerWallet,
  type WalletState,
} from './types.ts';

const ACCOUNT_TONE: Readonly<Record<CustomerWallet['accountStatus'], BadgeTone>> = {
  none: 'neutral',
  active: 'success',
  frozen: 'critical',
  closed: 'neutral',
};

const ACCOUNT_STATES: readonly string[] = ['none', 'active', 'frozen', 'closed'];

type Fields = { amount?: string; reason?: string; note?: string };

/** Control and format characters other than a line break: the API refuses a note with them. */
const NOTE_FORBIDDEN = /[^\P{C}\n]/u;

/**
 * Issue promo store credit to one customer. The summary (balances and the caller's caps) loads in
 * the browser so errors stay on the page. The idempotency key is made in code, kept while the same
 * request is retried and replaced after a final answer, so a double click never double-issues.
 */
export function CreditForm({
  customerId,
  canIssue,
  canViewSettings,
  canViewRequests,
  csrfToken,
}: {
  readonly customerId: string;
  /** wallet.credit.issue: without it the summary shows and the form is absent (the API decides). */
  readonly canIssue: boolean;
  readonly canViewSettings: boolean;
  readonly canViewRequests: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('wallet');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [summary, setSummary] = useState<CustomerWallet | null>(null);
  // The whole Market has the wallet off: the summary route answers wallet.disabled.
  const [marketOff, setMarketOff] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Fields>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AdminCredit | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const key = useRef<{ readonly value: string; readonly signature: string } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const result = await callApi<CustomerWallet>(
      'GET',
      `wallet/admin/customers/${encodeURIComponent(customerId)}`,
    );
    if (result.ok) {
      const body = result.body;
      // A state the panel does not know is not shown as a guess.
      if (
        !WALLET_STATES.includes(body.marketStatus) ||
        !ACCOUNT_STATES.includes(body.accountStatus)
      ) {
        setLoadFailed(true);
        return;
      }
      setSummary(body);
      setMarketOff(false);
      setNotFound(false);
    } else if (result.failure.code === 'wallet.customer-not-found') setNotFound(true);
    else if (result.failure.status === 401) window.location.assign('/session-ended');
    else if (result.failure.code === 'wallet.disabled') setMarketOff(true);
    else setLoadFailed(true);
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A failed submit moves focus to the summary banner.
  useEffect(() => {
    if (problem !== null) alertRef.current?.focus();
  }, [problem, fields]);

  if (loadFailed) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('load-failed')}
        retryLabel={t('retry')}
        onRetry={() => void load()}
      />
    );
  }
  if (notFound) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Banner tone="attention">{t('error.customer-not-found')}</Banner>
        <LinkButton variant="secondary" href="/customers">
          {t('credit.choose.action')}
        </LinkButton>
      </div>
    );
  }
  if (marketOff) {
    return (
      <Banner tone="attention">
        {t('error.disabled')}{' '}
        {canViewSettings ? (
          <a className="font-medium underline" href="/settings/wallet">
            {t('credit.open-switch')}
          </a>
        ) : null}
      </Banner>
    );
  }
  if (summary === null) return <SkeletonRows label={t('loading')} rows={4} />;

  if (decimalsOf(summary.currency) === null) {
    return <Banner tone="critical">{t('error.currency-unsupported')}</Banner>;
  }
  const money = (minor: string) => formatMinor(minor, summary.currency, locale);
  const marketState: WalletState = summary.marketStatus;
  const marketBlocked = marketState !== 'active';
  const accountBlocked = summary.accountStatus === 'frozen' || summary.accountStatus === 'closed';
  const disabled = marketBlocked || accountBlocked;

  // The hint is advisory; the server decides.
  const typed = parseAmount(amount, summary.currency);
  const hint = !typed.ok
    ? null
    : isMore(typed.minor, summary.issueCap) ||
        isMore(sumMinor(summary.usedToday, typed.minor), summary.dailyCap)
      ? 'needs-approval'
      : 'immediate';

  function validate(): { fields: Fields; minor: string | null } {
    const next: Fields = {};
    let minor: string | null = null;
    const parsed = parseAmount(amount, summary!.currency);
    if (!parsed.ok) {
      next.amount = t(`credit.amount-error.${parsed.problem}`, {
        example: exampleAmount(summary!.currency),
      });
    } else if (isMore(parsed.minor, summary!.roomUnderCap)) {
      next.amount = t('credit.amount-error.cap', { room: money(summary!.roomUnderCap) });
    } else minor = parsed.minor;
    if (reason === '') next.reason = t('credit.reason-error');
    const trimmed = note.trim();
    if ([...trimmed].length > NOTE_MAX || NOTE_FORBIDDEN.test(trimmed)) {
      next.note = t('credit.note-error');
    }
    return { fields: next, minor };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || disabled) return;
    setOutcome(null);
    setProblem(null);
    const checked = validate();
    setFields(checked.fields);
    if (checked.minor === null || Object.keys(checked.fields).length > 0) {
      setProblem('check');
      return;
    }
    const trimmed = note.trim();
    const request = {
      customerAccountId: customerId,
      amount: checked.minor,
      currency: summary!.currency,
      reasonCode: reason,
      ...(trimmed === '' ? {} : { note: trimmed }),
    };
    // The same request keeps its key (a retry after a lost answer); a changed one gets a new key.
    const signature = JSON.stringify(request);
    if (key.current?.signature !== signature) {
      key.current = { value: `adm-${crypto.randomUUID()}`, signature };
    }
    busy.current = true;
    setPending(true);
    const result = await guarded<AdminCredit>(
      'POST',
      'wallet/admin/credits',
      { ...request, idempotencyKey: key.current.value },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      key.current = null;
      setOutcome(result.body);
      setAmount('');
      setReason('');
      setNote('');
      setFields({});
      void load();
      return;
    }
    if (isStepUpCancelled(result)) return;
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    // Only a definite refusal ends the key; a lost or ambiguous answer keeps it for the retry.
    if (isDefiniteRefusal(failure)) key.current = null;
    const code = walletProblemOf(failure, 'issue');
    if (code === 'validation-issue') {
      const failed = failedFields(failure);
      const next: Fields = {};
      if (failed.includes('amount') || failed.includes('currency')) {
        next.amount = t('credit.amount-error.format', {
          example: exampleAmount(summary!.currency),
        });
      }
      if (failed.includes('reasonCode')) next.reason = t('credit.reason-error');
      if (failed.includes('note')) next.note = t('credit.note-error');
      setFields(next);
      setProblem(Object.keys(next).length > 0 ? 'check' : code);
      return;
    }
    if (['disabled', 'paused', 'frozen', 'cap-exceeded', 'account-not-active'].includes(code)) {
      void load();
    }
    setProblem(code);
  }

  const resultRows = (credit: AdminCredit) => [
    { label: t('result.amount'), value: formatMinor(credit.amount, credit.currency, locale) },
    {
      label: t('result.reason'),
      value: wordFor(t, 'credit.reason', credit.reasonCode),
    },
    {
      label: t('result.reference'),
      value: <span title={credit.id}>{shortId(credit.id)}</span>,
    },
    { label: t('result.time'), value: formatInstant(credit.requestedAt, locale) },
  ];

  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-4">
      <Card title={shortId(summary.customerAccountId)}>
        <div>
          <Badge tone={ACCOUNT_TONE[summary.accountStatus]}>
            {t(`credit.account.${summary.accountStatus}`)}
          </Badge>
        </div>
        <DataList
          missing=""
          rows={[
            { label: t('credit.available'), value: money(summary.available) },
            { label: t('credit.held'), value: money(summary.held) },
            { label: t('credit.balance-cap'), value: money(summary.balanceCap) },
            { label: t('credit.room'), value: money(summary.roomUnderCap) },
            {
              label: t('credit.used-today'),
              value: t('credit.used-today-value', {
                used: money(summary.usedToday),
                cap: money(summary.dailyCap),
              }),
            },
            {
              label: t('credit.issue-cap'),
              value: t('credit.issue-cap-value', { cap: money(summary.issueCap) }),
            },
          ]}
        />
      </Card>
      {marketBlocked && canIssue ? (
        <Banner tone="attention">
          {t(`error.${marketState === 'off' ? 'disabled' : marketState}`)}{' '}
          {canViewSettings ? (
            <a className="font-medium underline" href="/settings/wallet">
              {t('credit.open-switch')}
            </a>
          ) : null}
        </Banner>
      ) : null}
      {!marketBlocked && accountBlocked && canIssue ? (
        <Banner tone="attention">{t('error.account-not-active')}</Banner>
      ) : null}
      {outcome === null ? null : (
        <div className="flex flex-col gap-3">
          <Banner
            tone={outcome.status === 'pending' ? 'attention' : 'success'}
            title={t(
              outcome.status === 'pending' ? 'result.pending.title' : 'result.granted.title',
            )}
          >
            {outcome.status === 'pending' ? (
              <>
                <p>
                  {t('result.pending.body', {
                    amount: formatMinor(outcome.amount, outcome.currency, locale),
                  })}
                </p>
                {outcome.approvalReason === 'issue-cap' ||
                outcome.approvalReason === 'daily-cap' ? (
                  <p>
                    {t(`result.pending.${outcome.approvalReason}`, {
                      cap: money(
                        outcome.approvalReason === 'issue-cap'
                          ? summary.issueCap
                          : summary.dailyCap,
                      ),
                    })}
                  </p>
                ) : null}
                {outcome.expiresAt === null ? null : (
                  <p>
                    {t('result.pending.expires', {
                      when: formatInstant(outcome.expiresAt, locale),
                    })}
                  </p>
                )}
              </>
            ) : (
              <p>
                {t('result.granted.body', {
                  amount: formatMinor(outcome.amount, outcome.currency, locale),
                })}
              </p>
            )}
          </Banner>
          <DataList missing="" rows={resultRows(outcome)} />
          {outcome.status === 'pending' && canViewRequests ? (
            <ActionRow>
              <LinkButton variant="secondary" href="/wallet/credit-requests">
                {t('result.open-approvals')}
              </LinkButton>
            </ActionRow>
          ) : null}
        </div>
      )}
      {canIssue ? (
        <form onSubmit={(event) => void submit(event)} noValidate>
          <Card title={t('credit.form-title')}>
            {problem === null ? null : (
              <div ref={alertRef} tabIndex={-1}>
                <Banner tone="critical">
                  {problem === 'check' ? t('credit.check-fields') : t(`error.${problem}`)}
                </Banner>
              </div>
            )}
            <MoneyField
              label={t('credit.amount', { currency: summary.currency })}
              name="amount"
              value={amount}
              disabled={disabled}
              help={t('credit.amount-help', { room: money(summary.roomUnderCap) })}
              error={fields.amount}
              onChange={(event) => setAmount(event.target.value)}
              status={
                <span aria-live="polite" className="block min-h-5 text-sm">
                  {hint === null ? null : (
                    <span
                      className={
                        hint === 'needs-approval' ? 'text-attention-fg' : 'text-success-fg'
                      }
                    >
                      {t(`credit.hint.${hint}`)}
                    </span>
                  )}
                </span>
              }
            />
            <Select
              label={t('credit.reason-label')}
              name="reasonCode"
              placeholder={t('credit.reason-placeholder')}
              value={reason}
              disabled={disabled}
              options={CREDIT_REASONS.map((code) => ({
                value: code,
                label: t(`credit.reason.${code}`),
              }))}
              error={fields.reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <TextAreaField
              label={t('credit.note-label')}
              name="note"
              rows={4}
              value={note}
              disabled={disabled}
              help={t('credit.note-help')}
              counter={t('credit.note-counter', { count: [...note].length, max: NOTE_MAX })}
              error={fields.note}
              onChange={(event) => setNote(event.target.value)}
            />
            <ActionRow>
              <Button type="submit" loading={pending} disabled={disabled}>
                {t('credit.submit')}
              </Button>
            </ActionRow>
          </Card>
        </form>
      ) : null}
    </div>
  );
}
