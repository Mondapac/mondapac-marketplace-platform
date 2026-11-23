import { LoadError, PageHeader } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { parseQueueTab } from '../../../src/catalog/review-queue-params.ts';
import { ReviewQueueView } from '../../../src/catalog/review-queue-view.tsx';
import { VIEW_PERMISSION } from '../../../src/catalog/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.queue.title') };
}

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The review queue (panels IA 3.1, product version review design 1; super list phase 2, lists 13
 * and 14): a tab for pending product revisions and one for Offers waiting for their first
 * publication, each a super list read by the browser through the panel's own routes.
 */
export default async function ReviewQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const tab = parseQueueTab(await searchParams);
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.queue.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="review-queue" title={title}>
      <PageHeader title={title} className="mb-4" />
      {body}
    </AdminShell>
  );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('catalog.queue.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('catalog.review.back-home')}
          </a>
        </p>
      </>,
    );
  }
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return shell(
    <ReviewQueueView
      tab={tab}
      paging={paging}
      accountId={gate.session.accountId}
      marketId={marketId}
      csrfToken={gate.session.csrfToken}
    />,
  );
}
