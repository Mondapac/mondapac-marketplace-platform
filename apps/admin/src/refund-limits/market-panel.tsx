'use client';

import {
  Badge,
  Banner,
  Button,
  DataList,
  EmptyState,
  SettingsPage,
  SettingsSection,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatInstantInZone } from '../shared/format.ts';
import { formatMinor } from '../wallet/money.ts';
import { LimitDialog, readLimits } from './limit-dialog.tsx';
import { REFUND_LIMITS_PATH, type RefundLimits } from './types.ts';

/**
 * Settings › Seller refund caps: the Market default cap on the refunds a seller starts by marking
 * units unavailable. With no cap set at all every such seller refund is refused (fail-closed), and
 * the empty state says so. Without the manage key the page is read-only and shows no action.
 */
export function RefundLimitsPanel({
  initial,
  canManage,
  csrfToken,
  zone,
}: {
  readonly initial: RefundLimits;
  readonly canManage: boolean;
  readonly csrfToken: string;
  /** The IANA zone the update time is shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('refund-limits');
  const locale = useLocale();
  const [limits, setLimits] = useState(initial);
  const [open, setOpen] = useState(false);
  const current = limits.marketDefault;

  return (
    <SettingsPage title={t('title')}>
      <SettingsSection
        title={t('market.section')}
        description={canManage ? t('market.intro') : t('read-only')}
      >
        <div className="flex flex-col gap-4 p-5">
          {current === null ? (
            <EmptyState
              icon="wallet"
              size="compact"
              title={t('market.empty-title')}
              body={t('market.empty-body')}
              action={
                canManage ? (
                  <Button className="min-h-12" onClick={() => setOpen(true)}>
                    {t('market.set')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <DataList
                missing="-"
                rows={[
                  { label: t('field.count-view'), value: String(current.maxCount) },
                  {
                    label: t('field.amount-view'),
                    value: (
                      <span dir="ltr">
                        {formatMinor(current.maxAmount.amount, limits.currency, locale)}
                      </span>
                    ),
                  },
                  {
                    label: t('market.version'),
                    value: (
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">
                          {t('market.version-n', { version: current.version })}
                        </Badge>
                        <span className="text-fg-muted">
                          {t('market.updated', {
                            when: formatInstantInZone(current.updatedAt, locale, zone),
                          })}
                        </span>
                      </span>
                    ),
                  },
                ]}
              />
              {canManage ? (
                <div>
                  <Button variant="secondary" className="min-h-12" onClick={() => setOpen(true)}>
                    {t('market.edit')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {current === null && !canManage ? (
            <Banner tone="attention">{t('market.empty-view')}</Banner>
          ) : null}
        </div>
      </SettingsSection>
      {canManage ? (
        <LimitDialog
          open={open}
          title={current === null ? t('market.set-title') : t('market.edit-title')}
          intro={t('market.dialog-intro')}
          currency={limits.currency}
          current={current}
          path={REFUND_LIMITS_PATH}
          csrfToken={csrfToken}
          onClose={() => setOpen(false)}
          onSaved={(next) => {
            setLimits(next);
            setOpen(false);
            toast.success(t('market.saved'));
          }}
          onStale={async () => {
            const fresh = await readLimits(REFUND_LIMITS_PATH);
            if (fresh !== null) setLimits(fresh);
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
