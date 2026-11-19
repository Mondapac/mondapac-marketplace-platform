'use client';

import { Banner, ConfirmAction, RadioGroup, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { isUuid } from '../../sales/search-route.ts';
import { shortId } from '../../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../../step-up/step-up.tsx';
import { sellerProblemOf } from '../seller-errors.ts';
import {
  ADMIN_HOLD_REASONS,
  HOLD_REASONS,
  RELEASE_REASONS,
  type PayoutHold,
} from '../seller-types.ts';
import type { HoldListRow } from './holds-list-types.ts';

export type HoldAsk =
  { readonly kind: 'place' } | { readonly kind: 'release'; readonly hold: HoldListRow };

/**
 * Place a hold… and Release hold… are money actions of level 3: the dialog says what stops or
 * restarts, asks for a reason from the closed list, and the admin types the short id of the
 * seller (to place) or of the hold (to release) before the red button works; focus starts on
 * Cancel. The guarded call then opens the shared step-up dialog for the code, and a cancelled
 * code leaves this dialog as it was. The answer drives the list (it reads its rows again);
 * nothing here edits a row.
 */
export function HoldDialogs({
  ask,
  sellerId,
  csrfToken,
  onClose,
  onDone,
  onRefused,
}: {
  readonly ask: HoldAsk | null;
  readonly sellerId: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** Placed or released: the list says so and reads its rows again. */
  readonly onDone: (kind: 'place' | 'release') => void;
  /** Refused for any reason but a cancelled code or a lost session: the list reads again. */
  readonly onRefused: () => void;
}) {
  const t = useTranslations('payouts.seller.holds');
  const tl = useTranslations('payouts.seller.holds.list.dialog');
  const guarded = useGuardedCall();
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'seller' | 'order'>('seller');
  const [orderId, setOrderId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // Every opening starts clean.
  useEffect(() => {
    setReason('');
    setScope('seller');
    setOrderId('');
    setError(null);
    setPending(false);
  }, [ask]);

  const placing = ask?.kind === 'place';
  const releasing = ask?.kind === 'release' ? ask.hold : null;
  const order = orderId.trim();
  const orderBad = placing && scope === 'order' && order !== '' && !isUuid(order);
  const orderReady = scope !== 'order' || isUuid(order);

  async function confirm() {
    if (ask === null || busy.current || reason === '' || (placing && !orderReady)) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result =
      ask.kind === 'place'
        ? await guarded<PayoutHold>(
            'POST',
            `commission-payouts/admin/sellers/${encodeURIComponent(sellerId)}/payout-holds`,
            scope === 'order' ? { reason, sellerOrderId: order.toLowerCase() } : { reason },
            csrfToken,
          )
        : await guarded<PayoutHold>(
            'POST',
            `commission-payouts/admin/payout-holds/${encodeURIComponent(ask.hold.holdId)}/release`,
            { reason },
            csrfToken,
          );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onDone(ask.kind);
      return;
    }
    // A cancelled code leaves the dialog exactly as it was.
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(t(`error.${sellerProblemOf(result.failure)}` as 'error.unknown'));
    // The row on screen may be out of date (already released, gone): the list reads again.
    onRefused();
  }

  return (
    <>
      <ConfirmAction
        open={placing}
        level={3}
        title={tl('place.title')}
        body={
          <div className="flex flex-col gap-4">
            <p>{t('place-intro')}</p>
            <Select
              label={t('reason-label')}
              name="holdReason"
              value={reason}
              disabled={pending}
              options={[
                { value: '', label: t('reason-placeholder'), disabled: true },
                ...ADMIN_HOLD_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) })),
              ]}
              onChange={(event) => setReason(event.target.value)}
            />
            <RadioGroup
              legend={t('scope.legend')}
              name="holdScope"
              value={scope}
              options={[
                { value: 'seller', label: t('scope.seller') },
                { value: 'order', label: t('scope.order') },
              ]}
              onChange={(value) => setScope(value === 'order' ? 'order' : 'seller')}
            />
            {scope === 'order' ? (
              <TextField
                name="sellerOrderId"
                label={t('scope.order-id')}
                help={t('scope.order-help')}
                value={orderId}
                error={orderBad ? t('error.order') : undefined}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setOrderId(event.target.value)}
              />
            ) : null}
          </div>
        }
        rowName={shortId(sellerId)}
        typeLabel={tl('place.type', { id: shortId(sellerId) })}
        stepUpNote={tl('step-up-note')}
        confirmLabel={tl('place.confirm')}
        cancelLabel={t('cancel')}
        pending={pending}
        confirmDisabled={reason === '' || !orderReady}
        error={placing ? error : null}
        onConfirm={() => void confirm()}
        onCancel={onClose}
      />
      <ConfirmAction
        open={releasing !== null}
        level={3}
        title={tl('release.title')}
        body={
          releasing === null ? null : (
            <div className="flex flex-col gap-4">
              <p>
                {t('release-body', {
                  reason: (HOLD_REASONS as readonly string[]).includes(releasing.reason)
                    ? t(`reason.${releasing.reason}` as 'reason.dispute')
                    : t('reason.unknown'),
                  covers:
                    releasing.sellerOrderId === null
                      ? t('whole-seller')
                      : t('order', { id: shortId(releasing.sellerOrderId) }),
                })}
              </p>
              {releasing.reason === 'seller-suspended' ? (
                <Banner tone="attention">{t('suspended-note')}</Banner>
              ) : null}
              <Select
                label={t('release-reason-label')}
                name="releaseReason"
                value={reason}
                disabled={pending}
                options={[
                  { value: '', label: t('reason-placeholder'), disabled: true },
                  ...RELEASE_REASONS.map((code) => ({ value: code, label: t(`release.${code}`) })),
                ]}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )
        }
        rowName={releasing === null ? '' : shortId(releasing.holdId)}
        typeLabel={tl('release.type', { id: releasing === null ? '' : shortId(releasing.holdId) })}
        stepUpNote={tl('step-up-note')}
        confirmLabel={tl('release.confirm')}
        cancelLabel={t('cancel')}
        pending={pending}
        confirmDisabled={reason === ''}
        error={releasing === null ? null : error}
        onConfirm={() => void confirm()}
        onCancel={onClose}
      />
    </>
  );
}
