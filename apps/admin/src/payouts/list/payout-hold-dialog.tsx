'use client';

import { Banner, ConfirmAction, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { shortId } from '../../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../../step-up/step-up.tsx';
import { sellerProblemOf } from '../seller-errors.ts';
import { ADMIN_HOLD_REASONS, RELEASE_REASONS, type PayoutHold } from '../seller-types.ts';
import type { PayoutListRow } from './payouts-list-types.ts';

/** Refusals that mean the row no longer shows the truth (as the seller page's holds card does). */
const STALE: readonly string[] = ['hold-released', 'hold-not-found', 'version-conflict'];

export type HoldAsk =
  | { readonly kind: 'place'; readonly row: PayoutListRow }
  | { readonly kind: 'release'; readonly row: PayoutListRow; readonly holdId: string };

/**
 * Hold payouts… and Release hold… of a payout row: money actions of level 3. The dialog names the
 * payout and the seller, asks for a reason from the closed list, and the admin types the payout's
 * reference to confirm; the call goes through the guarded call, so the shared step-up dialog asks
 * for the code. A hold from the list covers the whole seller (a hold on one seller order is placed
 * from the seller's page). A cancelled code leaves this dialog as it was.
 */
export function PayoutHoldDialog({
  ask,
  storeName,
  csrfToken,
  onClose,
  onDone,
  onStale,
}: {
  readonly ask: HoldAsk | null;
  readonly storeName: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** Placed or released: the list reads its rows again and says so. */
  readonly onDone: (kind: 'place' | 'release') => void;
  /** Refused because the row is out of date: the list reads its rows again behind the dialog. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('payouts.list.hold');
  const th = useTranslations('payouts.seller.holds');
  const guarded = useGuardedCall();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // Every opening starts clean.
  useEffect(() => {
    setReason('');
    setError(null);
    setPending(false);
  }, [ask]);

  const reference = ask === null ? '' : shortId(ask.row.payoutId);
  const kind = ask?.kind ?? 'place';

  async function confirm() {
    if (ask === null || busy.current || reason === '') return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result =
      ask.kind === 'place'
        ? await guarded<PayoutHold>(
            'POST',
            `commission-payouts/admin/sellers/${encodeURIComponent(ask.row.sellerId)}/payout-holds`,
            { reason },
            csrfToken,
          )
        : await guarded<PayoutHold>(
            'POST',
            `commission-payouts/admin/payout-holds/${encodeURIComponent(ask.holdId)}/release`,
            { reason },
            csrfToken,
          );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onDone(ask.kind);
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = sellerProblemOf(result.failure);
    setError(th(`error.${key}` as 'error.unknown'));
    if (STALE.includes(key)) onStale();
  }

  const reasons = kind === 'place' ? ADMIN_HOLD_REASONS : RELEASE_REASONS;
  return (
    <ConfirmAction
      open={ask !== null}
      level={3}
      title={t(`${kind}.title`, { store: storeName })}
      body={
        <div className="flex flex-col gap-4">
          <p>{t(`${kind}.body`, { id: reference, store: storeName })}</p>
          {kind === 'place' ? <Banner tone="info">{t('place.scope')}</Banner> : null}
          <Select
            label={kind === 'place' ? th('reason-label') : th('release-reason-label')}
            name={kind === 'place' ? 'holdReason' : 'releaseReason'}
            value={reason}
            disabled={pending}
            options={[
              { value: '', label: th('reason-placeholder'), disabled: true },
              ...reasons.map((code) => ({
                value: code,
                label:
                  kind === 'place'
                    ? th(`reason.${code}` as 'reason.admin-review')
                    : th(`release.${code}` as 'release.resolved'),
              })),
            ]}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      }
      rowName={reference}
      typeLabel={t('type-to-confirm', { id: reference })}
      stepUpNote={kind === 'place' ? t('step-up-note') : t('release-step-up-note')}
      confirmLabel={t(`${kind}.confirm`)}
      cancelLabel={th('cancel')}
      pending={pending}
      confirmDisabled={reason === ''}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}
