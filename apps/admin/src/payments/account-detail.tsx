import { Banner, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { formatInstant, known } from '../sellers/format.ts';
import { AccountStatusBadge } from './status-badge.tsx';
import { CHANGE_KINDS, type ConnectedAccountDetail } from './types.ts';

/** One connected account with its change history. Read-only. */
export function AccountDetail({ account }: { readonly account: ConnectedAccountDetail }) {
  const t = useTranslations('payments.accounts');
  const rows: readonly { readonly label: string; readonly value: string }[] = [
    { label: t('col.ready'), value: t(account.ready ? 'yes' : 'no') },
    { label: t('col.requirements'), value: String(account.requirementsDue) },
    { label: t('field.past-due'), value: t(account.requirementsPastDue ? 'yes' : 'no') },
    { label: t('col.cooling-off'), value: formatInstant(account.coolingOffUntil) },
    { label: t('col.paused'), value: t(account.payoutsPaused ? 'yes' : 'no') },
    { label: t('col.last-read'), value: formatInstant(account.lastReadAt) },
    { label: t('field.created'), value: formatInstant(account.createdAt) },
  ];
  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold break-words">{account.sellerName ?? t('unnamed')}</h1>
        <p className="mt-1 text-sm text-fg-muted wrap-anywhere">{account.sellerId}</p>
      </div>
      <Card title={t('detail.title')}>
        <div>
          <AccountStatusBadge status={account.status} />
        </div>
        {account.requirementsPastDue ? (
          <Banner tone="critical">{t('detail.past-due')}</Banner>
        ) : null}
        <dl className="flex flex-col gap-3 sm:grid sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col sm:contents">
              <dt className="text-fg-muted">{row.label}</dt>
              <dd className="font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t('detail.changes')}>
        {account.changes.length === 0 ? (
          <p className="text-fg-muted">{t('detail.no-changes')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-row">
            {account.changes.map((change) => (
              <li
                key={`${change.detectedAt}-${change.kind}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="font-medium">
                  {t(`change.${known(change.kind, CHANGE_KINDS)}`)}
                </span>
                <span className="text-sm text-fg-muted">{formatInstant(change.detectedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p>
        <a
          className="inline-flex min-h-12 items-center font-medium text-link underline"
          href="/payout-accounts"
        >
          {t('detail.back')}
        </a>
      </p>
    </div>
  );
}
