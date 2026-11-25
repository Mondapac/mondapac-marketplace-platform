'use client';

import { ConfirmAction, toast, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { PRICE_EDIT_PERMISSION } from '../price/types.ts';
import { STOCK_EDIT_PERMISSION } from '../stock/levels-types.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { offerActionErrorOf } from './offer-action-errors.ts';
import type { OfferListRow } from './types.ts';

type Step = 'submit' | 'delete';
interface Pending {
  readonly step: Step;
  readonly row: OfferListRow;
}

/**
 * The Actions menu of an Offer row: Open, Edit, Prices and Stock lead to their pages; Submit for
 * review and Delete change the Offer, so each asks first. The API names the actions a row has (open,
 * edit, submit, delete: the server decides per caller and Offer), and the panel adds Prices and
 * Stock from the session's permission keys, because catalog does not read other modules' keys.
 * Submit is a dialog that names the Offer and says what follows (level 2). Delete is irreversible:
 * the seller types the SKU, and the step-up code is asked when a rule needs it (level 3). Returns
 * the menu items of a row and the dialogs, which the list renders once.
 */
export function useOfferRowActions(
  csrfToken: string,
  permissionKeys: readonly string[],
  /** The Offer changed: the list reads its page again. */
  onChanged: () => void,
): { readonly items: (row: OfferListRow) => readonly MenuItem[]; readonly dialogs: ReactNode } {
  const t = useTranslations('catalog.offers.list.row-actions');
  const tr = useTranslations();
  const router = useRouter();
  const callGuarded = useGuardedCall();
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const busy = useRef(false);

  async function run(current: Pending) {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setProblem(null);
    const id = current.row.offerId;
    const result =
      current.step === 'submit'
        ? await callApi<{ published?: boolean }>(
            'POST',
            `catalog/seller/offers/${id}/submit`,
            undefined,
            csrfToken,
          )
        : await callGuarded<null>('DELETE', `catalog/seller/offers/${id}`, undefined, csrfToken);
    busy.current = false;
    setRunning(false);
    // The step-up code was cancelled: the dialog stays as it was, with no message.
    if (isStepUpCancelled(result)) return;
    if (result.ok) {
      setPending(null);
      toast.success(
        current.step === 'delete'
          ? t('done.delete')
          : result.body?.published === true
            ? t('done.published')
            : t('done.submit'),
      );
      onChanged();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(offerActionErrorOf(result.failure));
  }

  const items = (row: OfferListRow): readonly MenuItem[] => {
    const page = `/offers/${row.offerId}`;
    const has = (action: string) => row.actions.includes(action);
    const out: MenuItem[] = [];
    if (has('open')) out.push({ id: 'open', label: t('open'), onSelect: () => router.push(page) });
    if (has('edit')) {
      out.push({ id: 'edit', label: t('edit'), onSelect: () => router.push(`${page}/edit`) });
    }
    // Prices and stock are on the offer page (its sizes table): shown for a key that edits them.
    if (
      has('open') &&
      (permissionKeys.includes(PRICE_EDIT_PERMISSION) ||
        permissionKeys.includes(STOCK_EDIT_PERMISSION))
    ) {
      out.push({
        id: 'sizes',
        label: t('sizes'),
        onSelect: () => router.push(`${page}#sizes`),
      });
    }
    if (has('submit')) {
      out.push({
        id: 'submit',
        label: t('submit'),
        onSelect: () => {
          setProblem(null);
          setPending({ step: 'submit', row });
        },
      });
    }
    if (has('delete')) {
      out.push({
        id: 'delete',
        label: t('delete'),
        tone: 'critical',
        onSelect: () => {
          setProblem(null);
          setPending({ step: 'delete', row });
        },
      });
    }
    return out;
  };

  const name = pending === null ? '' : pending.row.sellerSku;
  const dialogs = (
    <ConfirmAction
      open={pending !== null}
      level={pending?.step === 'delete' ? 3 : 2}
      title={pending === null ? '' : t(`confirm.${pending.step}.title`, { sku: name })}
      body={pending === null ? '' : t(`confirm.${pending.step}.body`)}
      rowName={name}
      confirmLabel={pending === null ? '' : t(`confirm.${pending.step}.confirm`)}
      cancelLabel={t('confirm.cancel')}
      typeLabel={t('confirm.delete.type')}
      stepUpNote={pending?.step === 'delete' ? t('confirm.delete.step-up') : undefined}
      pending={running}
      error={problem === null ? null : tr(problem)}
      onConfirm={() => {
        if (pending !== null) void run(pending);
      }}
      onCancel={() => setPending(null)}
    />
  );
  return { items, dialogs };
}
