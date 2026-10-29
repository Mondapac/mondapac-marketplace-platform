'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  CARD_TABLE,
  Dialog,
  EmptyState,
  RadioGroup,
  Select,
  TextField,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { sellerProblemOf } from './seller-errors.ts';
import {
  ADMIN_HOLD_REASONS,
  canReleaseHold,
  HOLD_REASONS,
  RELEASE_REASONS,
  type PayoutHold,
} from './seller-types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TONE: Readonly<Record<string, BadgeTone>> = {
  'seller-suspended': 'critical',
  dispute: 'critical',
  'refund-pending': 'neutral',
  'admin-review': 'neutral',
  'bank-change': 'attention',
};
const COLUMNS = ['covers', 'reason', 'placed', 'status', 'actions'] as const;

/** Active holds first, then released ones, newest placed first inside each group (as the API sends). */
const ordered = (holds: readonly PayoutHold[]): PayoutHold[] => [
  ...holds.filter((hold) => hold.active),
  ...holds.filter((hold) => !hold.active),
];

/**
 * The payout holds of one seller. A hold covers the whole seller or one seller order and stops
 * payouts until it is released. An admin places only the two manual reasons and releases a hold
 * with a reason from a closed list; both go through the guarded call (the shared step-up dialog
 * asks for the code). The system's own holds end by themselves, so they have no button.
 */
export function PayoutHoldsCard({
  sellerId,
  initial,
  zone,
  canPlace,
  canRelease,
  csrfToken,
}: {
  readonly sellerId: string;
  readonly initial: readonly PayoutHold[];
  readonly zone: string;
  readonly canPlace: boolean;
  readonly canRelease: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('payouts.seller.holds');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [holds, setHolds] = useState(() => ordered(initial));
  const [dialog, setDialog] = useState<'place' | { readonly release: PayoutHold } | null>(null);
  const [notice, setNotice] = useState<'placed' | 'released' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'seller' | 'order'>('seller');
  const [orderId, setOrderId] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const busy = useRef(false);

  const when = (iso: string) => shortInstantInZone(iso, locale, zone);
  const reasonLabel = (code: string) =>
    (HOLD_REASONS as readonly string[]).includes(code)
      ? t(`reason.${code}` as 'reason.dispute')
      : code;

  async function reread() {
    const result = await callApi<{ holds: PayoutHold[] }>(
      'GET',
      `commission-payouts/admin/sellers/${sellerId}/payout-holds`,
    );
    if (result.ok) setHolds(ordered(result.body.holds));
  }

  function fail(failure: Parameters<typeof sellerProblemOf>[0]) {
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = sellerProblemOf(failure);
    setProblem(key);
    if (key === 'hold-released' || key === 'hold-not-found') void reread();
  }

  async function place() {
    if (busy.current) return;
    const found: Record<string, string> = {};
    if (reason === '') found.reason = t('error.reason');
    if (scope === 'order' && !UUID.test(orderId.trim())) found.order = t('error.order');
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    setDialog(null);
    const result = await guarded<PayoutHold>(
      'POST',
      `commission-payouts/admin/sellers/${sellerId}/payout-holds`,
      scope === 'order' ? { reason, sellerOrderId: orderId.trim() } : { reason },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setHolds((current) => ordered([result.body, ...current]));
      setNotice('placed');
      return;
    }
    if (isStepUpCancelled(result)) {
      setDialog('place');
      return;
    }
    fail(result.failure);
  }

  async function release(hold: PayoutHold) {
    if (busy.current) return;
    if (reason === '') {
      setErrors({ reason: t('error.reason') });
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    setDialog(null);
    const result = await guarded<PayoutHold>(
      'POST',
      `commission-payouts/admin/payout-holds/${encodeURIComponent(hold.holdId)}/release`,
      { reason },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setHolds((current) =>
        ordered(current.map((entry) => (entry.holdId === hold.holdId ? result.body : entry))),
      );
      setNotice('released');
      return;
    }
    if (isStepUpCancelled(result)) {
      setDialog({ release: hold });
      return;
    }
    fail(result.failure);
  }

  const releasing = dialog !== null && dialog !== 'place' ? dialog.release : null;
  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-4">
        {canPlace ? (
          <div>
            <Button
              disabled={pending}
              onClick={() => {
                setReason('');
                setScope('seller');
                setOrderId('');
                setErrors({});
                setProblem(null);
                setNotice(null);
                setDialog('place');
              }}
            >
              {t('place')}
            </Button>
          </div>
        ) : null}
        {notice === null ? null : <Banner tone="success">{t(`done.${notice}`)}</Banner>}
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        {holds.length === 0 ? (
          <EmptyState icon="shield-check" title={t('empty.title')} body={t('empty.body')} />
        ) : (
          <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
            <table className={CARD_TABLE.table}>
              <caption className="sr-only">{t('title')}</caption>
              <thead className={CARD_TABLE.head}>
                <tr>
                  {COLUMNS.map((col) => (
                    <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                      {col === 'actions' ? (
                        <span className="sr-only">{t('col.actions')}</span>
                      ) : (
                        t(`col.${col}`)
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={CARD_TABLE.body}>
                {holds.map((hold) => (
                  <tr key={hold.holdId} className={CARD_TABLE.row}>
                    <td className={CARD_TABLE.cell}>
                      <span title={hold.sellerOrderId ?? undefined}>
                        {hold.sellerOrderId === null
                          ? t('whole-seller')
                          : t('order', { id: shortId(hold.sellerOrderId) })}
                      </span>
                    </td>
                    <td className={CARD_TABLE.corner}>
                      <Badge tone={TONE[hold.reason] ?? 'neutral'}>
                        {reasonLabel(hold.reason)}
                      </Badge>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('col.placed')}>
                      <span>
                        {t('placed-by', {
                          when: when(hold.placedAt),
                          origin: t(`origin.${hold.origin}`),
                        })}
                      </span>
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('col.status')}>
                      <span>
                        {hold.active
                          ? t('active')
                          : t('released', {
                              when: hold.releasedAt === null ? '-' : when(hold.releasedAt),
                              reason:
                                hold.releaseReason === null
                                  ? '-'
                                  : t(`release.${hold.releaseReason}` as 'release.resolved'),
                            })}
                      </span>
                    </td>
                    <td className={`${CARD_TABLE.labelled} max-lg:!block`} data-label="">
                      {canRelease && canReleaseHold(hold) ? (
                        <Button
                          variant="secondary"
                          disabled={pending}
                          onClick={() => {
                            setReason('');
                            setErrors({});
                            setProblem(null);
                            setNotice(null);
                            setDialog({ release: hold });
                          }}
                        >
                          {t('release-action')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-fg-muted">{t('footnote', { zone })}</p>
      </div>
      <Dialog
        open={dialog === 'place'}
        title={t('place-title')}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void place()}>{t('place-yes')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm">{t('place-intro')}</p>
          <Select
            label={t('reason-label')}
            name="reason"
            value={reason}
            error={errors.reason}
            options={[
              { value: '', label: t('reason-placeholder'), disabled: true },
              ...ADMIN_HOLD_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) })),
            ]}
            onChange={(event) => setReason(event.target.value)}
          />
          <RadioGroup
            legend={t('scope.legend')}
            name="scope"
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
              error={errors.order}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setOrderId(event.target.value)}
            />
          ) : null}
        </div>
      </Dialog>
      <Dialog
        open={releasing !== null}
        title={t('release-title')}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (releasing !== null) void release(releasing);
              }}
            >
              {t('release-yes')}
            </Button>
          </>
        }
      >
        {releasing === null ? null : (
          <div className="flex flex-col gap-4">
            <p>
              {t('release-body', {
                reason: reasonLabel(releasing.reason),
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
              error={errors.reason}
              options={[
                { value: '', label: t('reason-placeholder'), disabled: true },
                ...RELEASE_REASONS.map((code) => ({ value: code, label: t(`release.${code}`) })),
              ]}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        )}
      </Dialog>
    </Card>
  );
}
