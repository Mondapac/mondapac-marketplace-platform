import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AccountsList } from '../../../src/payments/accounts-list.tsx';
import { VIEW_PERMISSION } from '../../../src/payments/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { displayZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payments.accounts.title') };
}

/**
 * Seller accounts (list 22): the connected payout accounts as a super list. The page reads the
 * Market's List paging setting and hands the list its zone; the list reads its own rows.
 */
export default async function PayoutAccountsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  const title = t('payments.accounts.title');
  if (gate.kind === 'unavailable') {
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
      <AdminShell session={session} activeId="payout-accounts" title={title}>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('payments.accounts.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('payments.accounts.back-home')}
          </a>
        </p>
      </AdminShell>
    );
  }
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read means Previous and next.
  const [mode, host] = await Promise.all([
    serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
    headers(),
  ]);
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '';
  return (
    <AdminShell session={session} activeId="payout-accounts" title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <AccountsList
        paging={paging}
        accountId={session.accountId}
        marketId={marketId}
        zone={displayZone(session.timezone)}
      />
    </AdminShell>
  );
}
