'use client';

import { Banner, Button, Dialog, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { MoneyField } from '../wallet/money-field.tsx';
import { exampleAmount } from '../wallet/money.ts';
import { refundLimitProblemOf } from './errors.ts';
import { bodyOf, formOf, type LimitFormErrors } from './form.ts';
import { MAX_COUNT, type RefundLimit, type RefundLimits } from './types.ts';

/**
 * The form that sets one cap: the Market default or one seller's own. The amount is typed in major
 * units of the Market currency (from the API) and sent as a minor-unit string. The write is a
 * guarded call (the protected manage key may ask a code); the version sent is the one of the cap
 * shown, so a stale save answers 409, the cap is read again through `onStale`, and the admin
 * checks it and saves again. Nothing is optimistic: the screen adopts the server's answer.
 */
export function LimitDialog({
  open,
  title,
  intro,
  currency,
  current,
  path,
  csrfToken,
  onClose,
  onSaved,
  onStale,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly intro: string;
  readonly currency: string;
  /** The cap being changed (its version is sent), or null for a first cap. */
  readonly current: RefundLimit | null;
  readonly path: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: (next: RefundLimits) => void;
  /** Reads the caps again after a stale save, so `current` carries the newest version. */
  readonly onStale: () => Promise<void>;
}) {
  const t = useTranslations('refund-limits');
  const guarded = useGuardedCall();
  const [count, setCount] = useState('');
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<LimitFormErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const [failures, setFailures] = useState(0);

  // A failed or stale save moves focus to the announced error, so a keyboard user lands on it.
  useEffect(() => {
    if (failures > 0) alertRef.current?.focus();
  }, [failures]);

  // Each opening starts from the cap in force; a re-read after a stale save keeps what was typed.
  useEffect(() => {
    if (!open) return;
    const start = formOf(current, currency);
    setCount(start.count);
    setAmount(start.amount);
    setErrors({});
    setProblem(null);
    // Only on opening: `current` changes again after a stale save and must not reset the form.
  }, [open]);

  async function save() {
    if (busy.current) return;
    const checked = bodyOf({ count, amount }, currency);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setProblem(null);
    busy.current = true;
    setPending(true);
    const result = await guarded<RefundLimits>(
      'PUT',
      path,
      { ...checked.body, expectedVersion: current?.version ?? 0 },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onSaved(result.body);
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = refundLimitProblemOf(result.failure);
    setProblem(key);
    setFailures((n) => n + 1);
    if (key === 'stale') await onStale();
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" className="min-h-12" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button className="min-h-12" onClick={() => void save()} loading={pending}>
            {t('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm">{intro}</p>
        {problem === null ? null : (
          <div ref={alertRef} tabIndex={-1} className="outline-none">
            <Banner tone="critical">{t(`error.${problem}`)}</Banner>
          </div>
        )}
        <TextField
          name="maxCount"
          label={t('field.count')}
          help={t('field.count-help', { max: MAX_COUNT })}
          inputMode="numeric"
          autoComplete="off"
          dir="ltr"
          value={count}
          error={errors.count === undefined ? undefined : t('error.count', { max: MAX_COUNT })}
          onChange={(event) => setCount(event.target.value)}
        />
        <MoneyField
          name="maxAmount"
          label={t('field.amount', { currency })}
          help={t('field.amount-help', { example: exampleAmount(currency) })}
          value={amount}
          error={errors.amount === undefined ? undefined : t(`error.${errors.amount}`)}
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
    </Dialog>
  );
}

/** Reads the caps again; null when it fails (the screen keeps what it shows). */
export async function readLimits(path: string): Promise<RefundLimits | null> {
  const fresh = await callApi<RefundLimits>('GET', path);
  if (fresh.ok) return fresh.body;
  if (fresh.failure.status === 401) window.location.assign('/session-ended');
  return null;
}
