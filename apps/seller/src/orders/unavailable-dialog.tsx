'use client';

import { Banner, Button, Dialog, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatMinor } from '../price/money.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { UNAVAILABLE_STALE, unavailableProblemOf } from './errors.ts';
import { liveRefunds, remainingUnits, type Money, type SellerOrderView } from './types.ts';

/**
 * "Mark unavailable": the shop picks the units it cannot send; MondaPac refunds them to the
 * customer at once at their frozen price (and the rest of the shipping fee when nothing is left to
 * send), and the shop bears the refund. A protected action: the step-up dialog may ask for a code.
 * The refund amount is worked out by the API; this dialog lists the units and shows the amount
 * the API gave back.
 */
export function UnavailableDialog({
  open,
  onClose,
  order,
  csrfToken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly order: SellerOrderView;
  readonly csrfToken: string;
}) {
  const t = useTranslations('orders.unavailable');
  const to = useTranslations('orders');
  const locale = useLocale();
  const router = useRouter();
  const callGuarded = useGuardedCall();
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  // A closed dialog starts clean next time.
  useEffect(() => {
    if (!open) {
      setCounts({});
      setProblem(null);
    }
  }, [open]);

  const rows = order.lines
    .map((line) => ({ line, left: remainingUnits(order, line.lineId) }))
    .filter((row) => row.left > 0);
  const chosen = rows.filter((row) => (counts[row.line.lineId] ?? 0) > 0);
  const nothingLeftAfter =
    chosen.length > 0 && rows.every((row) => (counts[row.line.lineId] ?? 0) === row.left);

  async function submit() {
    if (busy.current || chosen.length === 0) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callGuarded<{ amount: Money }>(
      'POST',
      `ordering/seller/orders/${order.sellerOrderId}/unavailable`,
      {
        lines: chosen.map((row) => ({
          orderLineId: row.line.lineId,
          quantity: counts[row.line.lineId] ?? 0,
        })),
        expectedRefunds: liveRefunds(order),
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (isStepUpCancelled(result)) return;
    if (result.ok) {
      onClose();
      toast.success(
        t('done', {
          amount: formatMinor(result.body.amount.amount, result.body.amount.currency, locale),
        }),
      );
      router.refresh();
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = unavailableProblemOf(failure);
    if (UNAVAILABLE_STALE.has(key)) {
      onClose();
      toast.error(t(`error.${key}`));
      router.refresh();
      return;
    }
    setProblem(key);
  }

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={() => {
        if (!pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('keep')}
          </Button>
          <Button
            variant="destructive-solid"
            loading={pending}
            disabled={chosen.length === 0}
            onClick={() => void submit()}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        <p>{t('body')}</p>
        <ul className="flex flex-col gap-3">
          {rows.map(({ line, left }) => {
            const inputId = `unavailable-${line.lineId}`;
            const name =
              line.productName?.trim() ||
              to('line.fallback', { id: line.offerId.slice(-8).toUpperCase() });
            const variant = line.variantLabel?.trim() ?? '';
            return (
              <li key={line.lineId} className="flex items-center justify-between gap-3">
                <label htmlFor={inputId} className="min-w-0 break-words">
                  <span className="font-medium">
                    {name}
                    {variant !== '' ? ` · ${variant}` : ''}
                  </span>
                  <span className="block text-sm text-fg-muted">
                    {t('line-meta', {
                      left,
                      price: formatMinor(line.unitPrice.amount, line.unitPrice.currency, locale),
                    })}
                  </span>
                </label>
                <input
                  id={inputId}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={left}
                  step={1}
                  disabled={pending}
                  value={counts[line.lineId] ?? 0}
                  onChange={(event) => {
                    const value = Math.floor(Number(event.target.value));
                    setCounts((current) => ({
                      ...current,
                      [line.lineId]: Number.isFinite(value)
                        ? Math.min(left, Math.max(0, value))
                        : 0,
                    }));
                  }}
                  className="w-20 rounded-md border border-line bg-surface px-2 py-1.5 text-end tabular-nums"
                />
              </li>
            );
          })}
        </ul>
        <div role="status" className="rounded-md bg-subtle p-3 text-sm">
          {chosen.length === 0 ? (
            <p className="text-fg-muted">{t('summary-none')}</p>
          ) : (
            <>
              <p className="font-medium">{t('summary-title')}</p>
              <ul className="list-disc ps-5">
                {chosen.map((row) => (
                  <li key={row.line.lineId}>
                    {t('summary-line', {
                      quantity: counts[row.line.lineId] ?? 0,
                      name:
                        row.line.productName?.trim() ||
                        to('line.fallback', { id: row.line.offerId.slice(-8).toUpperCase() }),
                    })}
                  </li>
                ))}
              </ul>
              <p className="mt-2">{nothingLeftAfter ? t('summary-all') : t('summary-some')}</p>
            </>
          )}
        </div>
        <p className="text-sm text-fg-muted">{t('final')}</p>
      </div>
    </Dialog>
  );
}
