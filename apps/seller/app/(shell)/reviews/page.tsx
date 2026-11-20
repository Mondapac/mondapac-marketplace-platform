import { EmptyState } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { firstPagePath, type ListPaging } from '../../../src/reviews/query.ts';
import { ReviewsList } from '../../../src/reviews/reviews-list.tsx';
import { REVIEWS_VIEW_PERMISSION, type ReviewListPage } from '../../../src/reviews/types.ts';
import { panelHostFor } from '../../../src/server/bff.ts';
import { loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('reviews.title') };
}

/**
 * The Reviews page (a super list): the first page is read here (every review, newest first), and
 * the list follows the Market's "List paging" setting. A setting that cannot be read means
 * Previous and next, which works for any number of reviews.
 */
export default async function ReviewsPage() {
  const t = await getTranslations();
  const title = t('reviews.title');
  const mode = await serverGet<{ readonly listPaging: string }>('settings/seller/list-paging');
  const paging: ListPaging =
    mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const page = await loadCatalogPage<ReviewListPage>(
    firstPagePath(paging),
    REVIEWS_VIEW_PERMISSION,
  );
  // Reviews are off until the admins switch them on: the API then answers "not found".
  if (page.kind === 'not-found') {
    return (
      <SellerShell session={page.session} activeId="s_reviews" title={title}>
        <EmptyState
          size="page"
          icon="star"
          title={t('reviews.off.title')}
          body={t('reviews.off.body')}
        />
      </SellerShell>
    );
  }
  const state = await catalogStateFor(page, 's_reviews', title);
  if (state !== null || page.kind !== 'ok') return state;
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const { session } = page;
  return (
    <SellerShell session={session} activeId="s_reviews" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <ReviewsList
        initial={page.body}
        paging={paging}
        accountId={session.accountId}
        marketId={marketId}
        csrfToken={session.csrfToken}
        timeZone={session.timezone}
      />
    </SellerShell>
  );
}
