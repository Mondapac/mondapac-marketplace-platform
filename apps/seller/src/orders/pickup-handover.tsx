'use client';

import { Banner, Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { callApi } from '../api/client.ts';
import { orderProblemOf } from './errors.ts';
import type { PickupStatus, SellerOrderView } from './types.ts';

const DIGITS = 4;

type Problem =
  | { readonly kind: 'wrong'; readonly attemptsLeft: number }
  | { readonly kind: 'locked' }
  | { readonly kind: 'other'; readonly key: string };

/**
 * The handover of an order the customer collects in person: four boxes for the customer's pickup
 * code and a "Confirm pickup" button. The code is only ever typed here; the panel never learns
 * it. A wrong code shows the tries left, the fifth locks the order until the customer asks for a
 * new code.
 */
export function PickupHandover({
  sellerOrderId,
  csrfToken,
  status,
  onCollected,
  onStatus,
}: {
  readonly sellerOrderId: string;
  readonly csrfToken: string;
  readonly status: PickupStatus;
  readonly onCollected: (order: SellerOrderView) => void;
  readonly onStatus: (status: PickupStatus) => void;
}) {
  const t = useTranslations('orders.pickup');
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: DIGITS }, () => ''));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const busy = useRef(false);
  const labelId = useId();
  const hintId = useId();
  const locked = status.locked;
  const code = digits.join('');
  const complete = code.length === DIGITS;

  function focusBox(index: number) {
    boxes.current[Math.max(0, Math.min(DIGITS - 1, index))]?.focus();
  }

  function setDigit(index: number, value: string) {
    setDigits((current) => current.map((digit, i) => (i === index ? value : digit)));
  }

  function typed(index: number, raw: string) {
    const entered = raw.replace(/\D/g, '');
    if (entered === '') {
      setDigit(index, '');
      return;
    }
    // A fast typist or an autofill can put several digits in one box: spread them.
    setDigits((current) => {
      const next = [...current];
      entered
        .slice(0, DIGITS - index)
        .split('')
        .forEach((digit, offset) => {
          next[index + offset] = digit;
        });
      return next;
    });
    focusBox(index + entered.length);
  }

  function keyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && digits[index] === '') focusBox(index - 1);
    else if (event.key === 'ArrowLeft') focusBox(index - 1);
    else if (event.key === 'ArrowRight') focusBox(index + 1);
    else if (event.key === 'Enter' && complete && !locked) void confirm();
  }

  function paste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, DIGITS);
    if (pasted === '') return;
    event.preventDefault();
    setDigits(Array.from({ length: DIGITS }, (_, i) => pasted[i] ?? ''));
    focusBox(pasted.length);
  }

  async function confirm() {
    if (busy.current || !complete || locked) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<SellerOrderView>(
      'POST',
      `ordering/seller/orders/${sellerOrderId}/confirm-pickup`,
      { code },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onCollected(result.body);
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setDigits(Array.from({ length: DIGITS }, () => ''));
    if (failure.code === 'ordering.pickup-code-invalid') {
      const attemptsLeft = failure.details?.attemptsLeft ?? Math.max(0, status.attemptsLeft - 1);
      onStatus({ attemptsLeft, locked: false });
      setProblem({ kind: 'wrong', attemptsLeft });
      focusBox(0);
      return;
    }
    if (failure.code === 'ordering.pickup-code-locked') {
      onStatus({ attemptsLeft: 0, locked: true });
      setProblem({ kind: 'locked' });
      return;
    }
    setProblem({ kind: 'other', key: orderProblemOf(failure) });
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby={labelId}>
      <h3 id={labelId} className="text-base font-semibold text-fg">
        {t('title')}
      </h3>
      <p id={hintId} className="text-sm text-balance text-fg-muted">
        {t('hint')}
      </p>
      {locked ? (
        <Banner tone="critical">{t('locked')}</Banner>
      ) : problem?.kind === 'wrong' ? (
        <Banner tone="critical">{t('wrong', { count: problem.attemptsLeft })}</Banner>
      ) : problem?.kind === 'other' ? (
        <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
      ) : null}
      {/* Digits always read left to right, in any page direction. */}
      <div role="group" aria-labelledby={labelId} dir="ltr" className="flex gap-2">
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(element) => {
              boxes.current[index] = element;
            }}
            value={digit}
            onChange={(event) => typed(index, event.target.value)}
            onKeyDown={(event) => keyDown(index, event)}
            onPaste={paste}
            onFocus={(event) => event.target.select()}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={DIGITS}
            disabled={locked || pending}
            aria-label={t('digit', { n: index + 1, total: DIGITS })}
            aria-describedby={hintId}
            aria-invalid={problem?.kind === 'wrong' ? true : undefined}
            className="h-14 w-12 rounded-md border border-line-control bg-surface text-center text-2xl font-semibold tabular-nums text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          />
        ))}
      </div>
      {locked ? null : (
        <p className="text-sm text-fg-muted" role="status">
          {t('attempts', { count: status.attemptsLeft })}
        </p>
      )}
      <div>
        <Button loading={pending} disabled={!complete || locked} onClick={() => void confirm()}>
          {t('submit')}
        </Button>
      </div>
    </section>
  );
}
