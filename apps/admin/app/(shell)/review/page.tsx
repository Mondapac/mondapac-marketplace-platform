import { LoadError, Tabs } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { ReviewQueue } from '../../../src/catalog/review-queue.tsx';
import {
  apiQueryOf,
  parseQueueParams,
  queueHref,
} from '../../../src/catalog/review-queue-params.ts';
import {
  QueueEmpty,
  RevisionFilters,
  RevisionQueueTable,
  SellerChip,
} from '../../../src/catalog/revision-queue.tsx';
import {
  DECIDE_PERMISSION,
  VIEW_PERMISSION,
  type QueuePage,
  type ReviewRow,
  type RevisionRow,
} from '../../../src/catalog/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.queue.title') };
}

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The review queue (panels IA 3.1, product version review design 1): a tab for pending product
 * revisions and one for Offers waiting for their first publication, each with its whole-queue
 * count. Revisions filter by change, photos and seller; Offers by seller. Keyset pages.
 */
export default async function ReviewQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = parseQueueParams(await searchParams);
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.queue.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="review-queue" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  const noAccess = (
    <>
      <p className="text-fg-muted">{t('catalog.queue.no-access')}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('catalog.review.back-home')}
        </a>
      </p>
    </>
  );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) return shell(noAccess);

  const result = await serverGet<QueuePage<RevisionRow | ReviewRow>>(
    `catalog/admin/review-queue?${apiQueryOf(params)}`,
  );
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(noAccess);
  if (result.kind !== 'ok') {
    return shell(
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('catalog.queue.unavailable')}
        retryLabel={t('load.retry')}
      />,
    );
  }
  const page = result.body;
  const canDecide = gate.session.permissionKeys.includes(DECIDE_PERMISSION);
  const revisions = page.items.filter((row): row is RevisionRow => row.kind === 'product-revision');
  const offers = page.items.filter(
    (row): row is ReviewRow => row.kind === 'offer-first-publication',
  );
  const morePages = page.nextAfterId !== null;
  const sellerName =
    params.seller === null
      ? null
      : ((
          page.items.find((row) => row.sellerId === params.seller && 'storeName' in row) as
            { readonly storeName: string | null } | undefined
        )?.storeName ?? null);
  const tabs = (['revision', 'offer'] as const).map((tab) => ({
    id: tab,
    label: t('catalog.queue.tab-count', {
      tab: t(`catalog.queue.tab.${tab}`),
      count: page.totals[tab === 'offer' ? 'offer-first-publication' : 'product-revision'],
    }),
    href: queueHref(params, { tab, change: 'all', photos: 'any' }),
  }));

  return shell(
    <div className="flex flex-col gap-4">
      <Tabs label={t('catalog.queue.tabs')} activeId={params.tab} items={tabs} />
      {params.tab === 'revision' ? (
        <>
          <RevisionFilters params={params} sellerName={sellerName} />
          {revisions.length === 0 ? (
            <QueueEmpty params={params} morePages={morePages} />
          ) : (
            <RevisionQueueTable rows={revisions} params={params} />
          )}
        </>
      ) : (
        <>
          <SellerChip params={params} sellerName={sellerName} />
          {offers.length === 0 ? (
            <QueueEmpty params={params} morePages={morePages} />
          ) : (
            <ReviewQueue
              rows={offers}
              canDecide={canDecide}
              csrfToken={gate.session.csrfToken}
              morePages={morePages}
            />
          )}
        </>
      )}
      {page.nextAfterId === null ? null : (
        <p>
          <a
            className="font-medium text-link underline"
            href={queueHref(params, { after: page.nextAfterId })}
          >
            {t('catalog.queue.more')}
          </a>
        </p>
      )}
    </div>,
  );
}
