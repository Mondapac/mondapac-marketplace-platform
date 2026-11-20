import { Badge, LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { isView, type View } from '../../../src/payouts/list/payouts-list-types.ts';
import { PayoutsList } from '../../../src/payouts/payouts-list.tsx';
import { VIEW_PERMISSION, type PayoutDetail, type PayoutPage } from '../../../src/payouts/types.ts';
import { toId } from '../../../src/sales/search-route.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { displayZone } from '../../../src/shared/format.ts';
import { formatMinor } from '../../../src/wallet/money.ts';

/** The page opens on the payouts that wait for an admin, the work of this page. */
const START_VIEW: View = 'awaiting-approval';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payouts.title') };
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

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export default async function PayoutsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly status?: string | readonly string[];
    readonly sellerId?: string | readonly string[];
  }>;
}) {
  const query = await searchParams;
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
  const status = one(query.status);
  const view: View = isView(status) ? status : START_VIEW;
  const seller = one(query.sellerId);
  // The API takes UUID v7 ids only; any other text is dropped rather than sent and refused.
  const sellerId = seller === undefined ? null : toId(seller);
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read means Previous and next.
  const [mode, limits, host] = await Promise.all([
    serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
    todayLimits(),
    headers(),
  ]);
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '';
  const zone = displayZone(session.timezone);
  return (
    <AdminShell session={session} activeId="payouts" title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <div className="flex flex-col gap-4">
        <p className="max-w-(--mp-size-form-max) text-sm text-fg-muted">{t('step-up.wait-note')}</p>
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
        <PayoutsList
          // A link to another view or seller is a fresh list.
          key={`${view}:${sellerId ?? ''}`}
          initialView={view}
          sellerId={sellerId}
          paging={paging}
          accountId={session.accountId}
          marketId={marketId}
          zone={zone}
          csrfToken={session.csrfToken}
          currency={limits?.todayTotal.currency ?? null}
        />
        <p className="text-sm text-fg-muted">{t('payouts.footnote', { zone })}</p>
      </div>
    </AdminShell>
  );
}
