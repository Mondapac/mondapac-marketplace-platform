'use client';

import { Banner, Button, Dialog, Select } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { shortId } from '../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { exampleAmount, formatMinor, isMore, parseAmount } from '../wallet/money.ts';
import { MoneyField } from '../wallet/money-field.tsx';
import { minorToField } from './amount.ts';
import {
  REASON_CODES,
  type DecisionBody,
  type DisputeSellerOrder,
  type ReasonCode,
} from './types.ts';

/** What the dialog is for: a first decision, or the return of a recovery the bank has undone. */
export interface DecisionTarget {
  readonly disputeId: string;
  readonly sellerOrder: DisputeSellerOrder;
  readonly mode: 'decide' | 'reverse';
}

type Bearer = 'platform' | 'seller';

/**
 * Who bears a lost chargeback, for one seller order. The code is not asked for here: saving goes
 * through the guarded call, so the shared step-up dialog asks for it, and a cancelled code leaves
 * this dialog as it was. Only a closed list of reasons; no free text.
 */
export function DecisionDialog({
  target,
  csrfToken,
  onClose,
  onSaved,
  onStale,
}: {
  readonly target: DecisionTarget | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  /** The case changed under the admin: the page reads it again; the dialog stays with its message. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('disputes.decision');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [bearer, setBearer] = useState<Bearer | ''>('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<ReasonCode | ''>('');
  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const order = target?.sellerOrder ?? null;
  const reverse = target?.mode === 'reverse';
  const cap = order?.recoverableCap ?? null;

  // Every opening starts clean: platform for a reversal, the full cap ready for a recovery.
  useEffect(() => {
    if (order === null || cap === null) return;
    setBearer(reverse ? 'platform' : '');
    setAmount(minorToField(cap.amountMinor, cap.currency));
    setReason('');
    setAmountError(undefined);
    setProblem(null);
  }, [order, cap, reverse]);

  const nothingToRecover = cap !== null && !isMore(cap.amountMinor, '0');
  const ready = bearer !== '' && reason !== '';
  const money = (minor: string, currency: string) => formatMinor(minor, currency, locale);

  async function save() {
    if (target === null || cap === null || busy.current || bearer === '' || reason === '') return;
    setProblem(null);
    setAmountError(undefined);
    let body: DecisionBody = { bearer, reasonCode: reason };
    if (bearer === 'seller') {
      const typed = parseAmount(amount, cap.currency);
      if (!typed.ok) {
        setAmountError(
          t(`amount-error.${typed.problem}`, { example: exampleAmount(cap.currency) }),
        );
        return;
      }
      if (isMore(typed.minor, cap.amountMinor)) {
        setAmountError(t('amount-error.range', { cap: money(cap.amountMinor, cap.currency) }));
        return;
      }
      body = { ...body, amountMinor: typed.minor };
    }
    busy.current = true;
    setPending(true);
    const result = await guarded(
      'POST',
      `commission-payouts/admin/disputes/${encodeURIComponent(target.disputeId)}/seller-orders/${encodeURIComponent(target.sellerOrder.sellerOrderId)}/decision`,
      body,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onSaved();
      return;
    }
    // A cancelled code leaves the dialog and what was typed exactly as they were.
    if (isStepUpCancelled(result)) return;
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.code === 'commission-payouts.dispute.amount-out-of-range') {
      setAmountError(t('amount-error.range', { cap: money(cap.amountMinor, cap.currency) }));
      return;
    }
    if (
      failure.code === 'validation.failed' &&
      failure.details?.fields?.some((field) => field.path === 'amountMinor') === true
    ) {
      setAmountError(t('amount-error.format', { example: exampleAmount(cap.currency) }));
      return;
    }
    if (
      failure.code === 'commission-payouts.dispute.not-decidable' ||
      failure.code === 'commission-payouts.dispute.already-decided'
    ) {
      setProblem(failure.code.endsWith('already-decided') ? 'already-decided' : 'not-decidable');
      onStale();
      return;
    }
    setProblem(failure.status === 404 ? 'not-found' : 'unknown');
  }

  return (
    <Dialog
      open={target !== null}
      title={t(reverse ? 'title-reverse' : 'title')}
      onClose={() => {
        if (!busy.current) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button
            disabled={!ready || (nothingToRecover && bearer === 'seller')}
            loading={pending}
            onClick={() => void save()}
          >
            {t('save')}
          </Button>
        </>
      }
    >
      {order === null || cap === null ? null : (
        <div className="flex flex-col gap-4">
          <p>
            {t('about', {
              store: order.storeName ?? shortId(order.sellerId),
              order: shortId(order.sellerOrderId),
            })}
          </p>
          {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
          {reverse ? (
            <p className="text-fg">
              {t('reverse-about', {
                amount:
                  order.decided?.amount == null
                    ? '-'
                    : money(order.decided.amount.amountMinor, order.decided.amount.currency),
              })}
            </p>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-fg">{t('bearer.legend')}</legend>
              {(['seller', 'platform'] as const).map((value) => {
                const off = value === 'seller' && nothingToRecover;
                return (
                  <label
                    key={value}
                    className={`flex min-h-(--mp-size-control) items-center gap-3 text-fg ${off ? 'text-fg-muted' : ''}`}
                  >
                    <input
                      type="radio"
                      name="bearer"
                      value={value}
                      checked={bearer === value}
                      disabled={off || pending}
                      className="size-5 accent-accent"
                      onChange={() => {
                        setBearer(value);
                        setAmountError(undefined);
                      }}
                    />
                    <span>{t(`bearer.${value}`)}</span>
                  </label>
                );
              })}
              {nothingToRecover ? (
                <p className="text-sm text-fg-muted">{t('nothing-to-recover')}</p>
              ) : null}
            </fieldset>
          )}
          {bearer === 'seller' && !reverse ? (
            <MoneyField
              label={t('amount.label', { currency: cap.currency })}
              name="amount"
              value={amount}
              disabled={pending}
              help={t('amount.hint', { cap: money(cap.amountMinor, cap.currency) })}
              error={amountError}
              onChange={(event) => {
                setAmount(event.target.value);
                setAmountError(undefined);
              }}
            />
          ) : null}
          <Select
            label={t('reason.label')}
            name="reasonCode"
            value={reason}
            disabled={pending}
            // The first option says what to do and cannot be picked again once left.
            options={[
              { value: '', label: t('reason.placeholder'), disabled: true },
              ...REASON_CODES.map((code) => ({ value: code, label: t(`reason.${code}`) })),
            ]}
            onChange={(event) => setReason(event.target.value as ReasonCode | '')}
          />
        </div>
      )}
    </Dialog>
  );
}
