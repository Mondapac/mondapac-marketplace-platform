'use client';

import { ActionRow, Badge, Banner, Button, Card, DataList, Dialog, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { formatInstantInZone } from '../shared/format.ts';
import { formatMinor } from '../wallet/money.ts';
import { refundLimitProblemOf } from './errors.ts';
import { LimitDialog, readLimits } from './limit-dialog.tsx';
import { sellerLimitsPath, sellerReadPath, type RefundLimit, type RefundLimits } from './types.ts';

type Dialogs = 'edit' | 'remove' | null;

/**
 * A seller's refund cap on the seller review page: which cap is in force (the seller's own, the
 * Market default, or none, which refuses every seller refund), and, with the manage key, set, edit
 * and remove the seller's own. Without it the card is read-only. The server decides every rule.
 */
export function RefundLimitCard({
  sellerId,
  initial,
  canManage,
  csrfToken,
  zone,
}: {
  readonly sellerId: string;
  readonly initial: RefundLimits;
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('refund-limits');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [limits, setLimits] = useState(initial);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const inForce: RefundLimit | null =
    limits.inForce === 'own'
      ? limits.own
      : limits.inForce === 'market'
        ? limits.marketDefault
        : null;
  const money = (limit: RefundLimit) =>
    formatMinor(limit.maxAmount.amount, limits.currency, locale);

  async function reread() {
    const fresh = await readLimits(sellerReadPath(sellerId));
    if (fresh !== null) setLimits(fresh);
  }

  async function remove() {
    if (busy.current || limits.own === null) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await guarded<RefundLimits>(
      'DELETE',
      `${sellerLimitsPath(sellerId)}?expectedVersion=${limits.own.version}`,
      undefined,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setLimits(result.body);
      setDialog(null);
      toast.success(t('seller.done.removed'));
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const key = refundLimitProblemOf(result.failure);
    setProblem(key);
    if (key === 'stale' || key === 'not-found') await reread();
  }

  const rows = [
    {
      label: t('seller.in-force'),
      value:
        limits.inForce === 'own' ? (
          <Badge tone="attention">{t('seller.source-own')}</Badge>
        ) : limits.inForce === 'market' ? (
          <Badge tone="neutral">{t('seller.source-market')}</Badge>
        ) : (
          <Badge tone="critical">{t('seller.source-none')}</Badge>
        ),
    },
    ...(inForce === null
      ? []
      : [
          { label: t('field.count-view'), value: String(inForce.maxCount) },
          { label: t('field.amount-view'), value: <span dir="ltr">{money(inForce)}</span> },
          {
            label: t('seller.updated'),
            value: formatInstantInZone(inForce.updatedAt, locale, zone),
          },
        ]),
  ];

  return (
    <Card title={t('seller.title')}>
      <div className="flex flex-col gap-4">
        {problem === null || dialog !== null ? null : (
          <Banner tone="critical">{t(`error.${problem}`)}</Banner>
        )}
        <DataList missing="-" rows={rows} />
        <p className="text-sm text-fg-muted">{t(`seller.note.${limits.inForce}`)}</p>
        {limits.inForce === 'own' && limits.marketDefault !== null ? (
          <p className="text-sm text-fg-muted">
            {t('seller.market-is', {
              count: limits.marketDefault.maxCount,
              amount: money(limits.marketDefault),
            })}
          </p>
        ) : null}
        {canManage ? (
          <ActionRow>
            <Button
              variant="secondary"
              className="min-h-12"
              disabled={pending}
              onClick={() => {
                setProblem(null);
                setDialog('edit');
              }}
            >
              {limits.own === null ? t('seller.set') : t('seller.edit')}
            </Button>
            {limits.own === null ? null : (
              <Button
                variant="destructive"
                className="min-h-12"
                disabled={pending}
                onClick={() => {
                  setProblem(null);
                  setDialog('remove');
                }}
              >
                {t('seller.remove')}
              </Button>
            )}
          </ActionRow>
        ) : (
          <p className="text-sm text-fg-muted">{t('read-only-seller')}</p>
        )}
      </div>
      {canManage ? (
        <>
          <LimitDialog
            open={dialog === 'edit'}
            title={limits.own === null ? t('seller.set-title') : t('seller.edit-title')}
            intro={t('seller.dialog-intro')}
            currency={limits.currency}
            current={limits.own}
            path={sellerLimitsPath(sellerId)}
            csrfToken={csrfToken}
            onClose={() => setDialog(null)}
            onSaved={(next) => {
              setLimits(next);
              setDialog(null);
              toast.success(t('seller.done.saved'));
            }}
            onStale={reread}
          />
          <Dialog
            open={dialog === 'remove'}
            title={t('seller.remove-title')}
            onClose={() => setDialog(null)}
            actions={
              <>
                <Button
                  variant="secondary"
                  className="min-h-12"
                  onClick={() => setDialog(null)}
                  disabled={pending}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="destructive-solid"
                  className="min-h-12"
                  onClick={() => void remove()}
                  loading={pending}
                >
                  {t('seller.remove-yes')}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
              <p>{t('seller.remove-body')}</p>
            </div>
          </Dialog>
        </>
      ) : null}
    </Card>
  );
}
