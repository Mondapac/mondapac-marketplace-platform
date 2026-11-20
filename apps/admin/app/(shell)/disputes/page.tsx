import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { DisputesList } from '../../../src/disputes/disputes-list.tsx';
import { isView, type View } from '../../../src/disputes/list/disputes-list-types.ts';
import { VIEW_PERMISSION } from '../../../src/disputes/types.ts';
import { toId } from '../../../src/sales/search-route.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { displayZone } from '../../../src/shared/format.ts';

/** Without a view in the link the list opens on the cases that wait for evidence. */
const START_VIEW: View = 'needs-response';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('disputes.title') };
}

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Disputes (list 23): the Market's dispute cases as a super list. A link may open a view
 * (`?view=`) and one seller's cases (`?sellerId=`, a UUID v7); the page reads the Market's List
 * paging setting and hands the list its zone, and the list reads its own rows.
 */
export default async function DisputesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly view?: string | readonly string[];
    readonly sellerId?: string | readonly string[];
  }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  const title = t('disputes.title');
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
      <AdminShell session={session} activeId="disputes" title={title}>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('disputes.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('disputes.back-home')}
          </a>
        </p>
      </AdminShell>
    );
  }
  const query = await searchParams;
  const asked = one(query.view);
  const view: View = isView(asked) ? asked : START_VIEW;
  const seller = one(query.sellerId);
  // The API takes UUID v7 ids only; any other text is dropped rather than sent and refused.
  const sellerId = seller === undefined ? null : toId(seller);
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read means Previous and next.
  const [mode, host] = await Promise.all([
    serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
    headers(),
  ]);
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '';
  return (
    <AdminShell session={session} activeId="disputes" title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      <div className="flex flex-col gap-4">
        <DisputesList
          // A link to another view or seller is a fresh list.
          key={`${view}:${sellerId ?? ''}`}
          initialView={view}
          sellerId={sellerId}
          paging={paging}
          accountId={session.accountId}
          marketId={marketId}
          zone={displayZone(session.timezone)}
        />
        <p className="text-sm text-fg-muted">{t('disputes.footnote')}</p>
      </div>
    </AdminShell>
  );
}
