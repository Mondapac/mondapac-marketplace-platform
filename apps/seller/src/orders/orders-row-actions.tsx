'use client';

import { ConfirmAction, toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { orderProblemOf } from './errors.ts';
import { shortId } from './status.ts';
import { UnavailableDialog } from './unavailable-dialog.tsx';
import { ROW_ACTIONS, type SellerOrderRow } from './types.ts';

type Step = 'ready' | 'deliver';
interface Pending {
  readonly step: Step;
  readonly row: SellerOrderRow;
}

/**
 * The Actions menu of an order row: exactly the actions the row's `actions` array names (the
 * server decides per caller and row), in the menu order; an id this panel does not know is ignored.
 * Open, Print packing slip and Copy order number are safe and run at once. Mark ready and Mark as
 * delivered change the order for the customer and MondaPac, so each asks first (a dialog that
 * names the order and says what follows). Hand over… leads to the order page, where the customer's
 * pickup code is typed. Report unavailable… opens the dialog of the order page (units, refund
 * and step-up code). Returns the menu items of a row and the dialogs, which the list renders once.
 */
export function useOrderRowActions(
  csrfToken: string,
  /** The order changed: the list reads its page again. */
  onChanged: () => void,
): { readonly items: (row: SellerOrderRow) => readonly MenuItem[]; readonly dialogs: ReactNode } {
  const t = useTranslations('orders.row-actions');
  const te = useTranslations('orders.error');
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [unavailable, setUnavailable] = useState<SellerOrderRow | null>(null);
  const busy = useRef(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copy-failed'));
    }
  }

  async function run(current: Pending) {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setProblem(null);
    const result = await callApi<SellerOrderRow>(
      'POST',
      `ordering/seller/orders/${current.row.sellerOrderId}/${current.step}`,
      {},
      csrfToken,
    );
    busy.current = false;
    setRunning(false);
    if (result.ok) {
      setPending(null);
      toast.success(t(`done.${current.step}`, { id: shortId(current.row.sellerOrderId) }));
      onChanged();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(orderProblemOf(result.failure));
  }

  const items = (row: SellerOrderRow): readonly MenuItem[] => {
    const page = `/orders/${row.sellerOrderId}`;
    return ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action): MenuItem => {
      switch (action) {
        case 'open':
          return { id: action, label: t('open'), onSelect: () => router.push(page) };
        case 'packing-slip':
          return {
            id: action,
            label: t('packing-slip'),
            onSelect: () => window.open(`${page}/packing-slip`, '_blank', 'noopener'),
          };
        case 'copy-number':
          return {
            id: action,
            label: t('copy-number'),
            onSelect: () => void copy(shortId(row.sellerOrderId)),
          };
        case 'ready':
          return {
            id: action,
            label: t('ready'),
            onSelect: () => {
              setProblem(null);
              setPending({ step: 'ready', row });
            },
          };
        case 'hand-over':
          return { id: action, label: t('hand-over'), onSelect: () => router.push(page) };
        case 'mark-delivered':
          return {
            id: action,
            label: t('mark-delivered'),
            onSelect: () => {
              setProblem(null);
              setPending({ step: 'deliver', row });
            },
          };
        case 'report-unavailable':
          return {
            id: action,
            label: t('report-unavailable'),
            tone: 'critical',
            onSelect: () => setUnavailable(row),
          };
      }
    });
  };

  const dialogs = (
    <>
      <ConfirmAction
        open={pending !== null}
        level={2}
        title={
          pending === null
            ? ''
            : t(`confirm.${pending.step}.title`, { id: shortId(pending.row.sellerOrderId) })
        }
        body={pending === null ? '' : t(`confirm.${pending.step}.body`)}
        rowName={pending === null ? '' : shortId(pending.row.sellerOrderId)}
        confirmLabel={pending === null ? '' : t(`confirm.${pending.step}.confirm`)}
        cancelLabel={t('confirm.cancel')}
        pending={running}
        error={problem === null ? null : te(problem)}
        onConfirm={() => {
          if (pending !== null) void run(pending);
        }}
        onCancel={() => setPending(null)}
      />
      {unavailable === null ? null : (
        <UnavailableDialog
          open
          order={unavailable}
          csrfToken={csrfToken}
          onClose={() => {
            setUnavailable(null);
            onChanged();
          }}
        />
      )}
    </>
  );

  return { items, dialogs };
}
