import { Badge, LoadError, Tabs } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { PayoutsList } from '../../../src/payouts/payouts-list.tsx';
import {
  APPROVE_PERMISSION,
  COUNT_PAGE_SIZE,
  TABS,
  VIEW_PERMISSION,
  type PayoutDetail,
  type PayoutPage,
  type Tab,
} from '../../../src/payouts/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { displayZone } from '../../../src/shared/format.ts';
import { formatMinor } from '../../../src/wallet/money.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payouts.title') };
}

/** How many payouts wait in a state: one page of the API, so "100+" when there is more. */
async function countOf(status: string): Promise<{ n: number; more: boolean } | null> {
  const read = await serverGet<PayoutPage>(
    `commission-payouts/admin/payouts?status=${status}&limit=${COUNT_PAGE_SIZE}`,
  );
  return read.kind === 'ok'
    ? { n: read.body.payouts.length, more: read.body.nextCursor !== null }
    : null;
}

/**
 * Today's total against the alert level. The list does not carry it, so it is read from the
 * limits of the newest payout; absent when there is no payout yet or it cannot be read.
 */
async function todayLimits(): Promise<PayoutDetail['limits']> {
  const newest = await serverGet<PayoutPage>('commission-payouts/admin/payouts?limit=1');
  const first = newest.kind === 'ok' ? newest.body.payouts[0] : undefined;
  if (first === undefined) return null;
  const detail = await serverGet<PayoutDetail>(
    `commission-payouts/admin/payouts/${first.payoutId}`,
  );
  return detail.kind === 'ok' ? detail.body.limits : null;
}

export default async function PayoutsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly status?: string | readonly string[] }>;
}) {
  const { status } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  const locale = await getLocale();
  const title = t('payouts.title');
  if (gate.kind === 'unavailable') {
    // No session, so no shell; the page still has its heading.
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </div>
    );
  }
  const { session } = gate;
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <AdminShell session={session} activeId="payouts" title={title}>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('payouts.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('payouts.back-home')}
          </a>
        </p>
      </AdminShell>
    );
  }
  const tab: Tab = TABS.find((entry) => entry === status) ?? 'awaiting-approval';
  const [awaiting, failed, limits] = await Promise.all([
    countOf('awaiting-approval'),
    countOf('failed'),
    todayLimits(),
  ]);
  const counts: Partial<Record<Tab, string>> = {
    ...(awaiting === null
      ? {}
      : { 'awaiting-approval': `${awaiting.n}${awaiting.more ? '+' : ''}` }),
    ...(failed === null ? {} : { failed: `${failed.n}${failed.more ? '+' : ''}` }),
  };
  const zone = displayZone(session.timezone);
  return (
    <AdminShell session={session} activeId="payouts" title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <div className="flex flex-col gap-4">
        <div className="flex max-w-(--mp-size-form-max) flex-col gap-1 text-fg-muted">
          <p>{t('payouts.intro')}</p>
          <p className="text-sm">{t('step-up.wait-note')}</p>
        </div>
        {limits === null ? null : (
          <p className="text-sm text-fg-muted">
            {t('payouts.today.line', {
              total: formatMinor(limits.todayTotal.amountMinor, limits.todayTotal.currency, locale),
              level: formatMinor(
                limits.dailyAlertLevel.amountMinor,
                limits.dailyAlertLevel.currency,
                locale,
              ),
            })}{' '}
            {limits.overDailyAlertLevel ? (
              <Badge tone="attention">{t('payouts.today.over')}</Badge>
            ) : null}
          </p>
        )}
        <Tabs
          label={t('payouts.tabs')}
          activeId={tab}
          items={TABS.map((id) => {
            const count = counts[id];
            return {
              id,
              label:
                count === undefined
                  ? t(`payouts.tab.${id}`)
                  : t('payouts.tab-count', { label: t(`payouts.tab.${id}`), count }),
              href: id === 'awaiting-approval' ? '/payouts' : `/payouts?status=${id}`,
            };
          })}
        />
        <PayoutsList
          // A tab is a fresh list: its own rows, cursors and open dialog.
          key={tab}
          tab={tab}
          canApprove={session.permissionKeys.includes(APPROVE_PERMISSION)}
          zone={zone}
          csrfToken={session.csrfToken}
        />
        <p className="text-sm text-fg-muted">{t('payouts.footnote', { zone })}</p>
      </div>
    </AdminShell>
  );
}
