import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { CreditRequestsList } from '../../../../src/wallet/credit-requests-list.tsx';
import { isView, type View } from '../../../../src/wallet/list/credit-requests-list-types.ts';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { displayZone } from '../../../../src/shared/format.ts';
import { CREDIT_VIEW } from '../../../../src/wallet/types.ts';
import { WalletPage } from '../../../../src/wallet/wallet-page.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('wallet.list.title') };
}

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The older queue's links (`?status=pending|decided|granted`) open the view of that name. */
const OLD_STATUS_VIEWS: readonly View[] = ['pending', 'decided', 'granted'];

/**
 * Credit requests (list 24): the Market's admin credit requests as a super list. A link may open a
 * view (`?view=`, or the older `?status=`); the page reads the Market's List paging setting and
 * hands the list its zone, and the list reads its own rows. Approving and rejecting stay with
 * their own permission: the list shows them in a row only when the API names them.
 */
export default async function CreditRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly view?: string | readonly string[];
    readonly status?: string | readonly string[];
  }>;
}) {
  const query = await searchParams;
  const asked = one(query.view);
  const old = one(query.status);
  const view: View = isView(asked)
    ? asked
    : (OLD_STATUS_VIEWS.find((entry) => entry === old) ?? 'pending');
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read (or may not be read) means Previous and next.
  const [t, mode, host] = await Promise.all([
    getTranslations(),
    serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
    headers(),
  ]);
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '';
  return (
    <WalletPage
      activeId="wallet-requests"
      title={t('wallet.list.title')}
      anyOf={[CREDIT_VIEW]}
      stepUpNote
      body={(session) => (
        <CreditRequestsList
          // A link to another view is a fresh list.
          key={view}
          initialView={view}
          paging={paging}
          accountId={session.accountId}
          csrfToken={session.csrfToken}
          marketId={marketId}
          zone={displayZone(session.timezone)}
        />
      )}
    />
  );
}
