import { EmptyState } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { SellerReviews } from '../../../src/reviews/seller-reviews.tsx';
import {
  REVIEWS_REPLY_PERMISSION,
  REVIEWS_REPORT_PERMISSION,
  REVIEWS_VIEW_PERMISSION,
  type SellerReviewPage,
} from '../../../src/reviews/types.ts';
import { loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('reviews.title') };
}

const CURSOR = /^[0-9]{1,15}_[0-9a-f-]{36}$/i;

export default async function ReviewsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations();
  const title = t('reviews.title');
  const raw = (await searchParams).cursor;
  const cursor = typeof raw === 'string' && CURSOR.test(raw) ? raw : undefined;
  const page = await loadCatalogPage<SellerReviewPage>(
    `reviews/seller${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
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
  const keys = page.session.permissionKeys;
  return (
    <SellerShell session={page.session} activeId="s_reviews" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <SellerReviews
        initial={page.body}
        csrfToken={page.session.csrfToken}
        canReply={keys.includes(REVIEWS_REPLY_PERMISSION)}
        canReport={keys.includes(REVIEWS_REPORT_PERMISSION)}
      />
    </SellerShell>
  );
}
