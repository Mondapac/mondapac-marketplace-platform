import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { ReviewQueue } from '../../../src/catalog/review-queue.tsx';
import {
  DECIDE_PERMISSION,
  PAGE_SIZE,
  VIEW_PERMISSION,
  type ReviewPage,
} from '../../../src/catalog/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.review.title') };
}

export default async function OfferReviewsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly after?: string | readonly string[] }>;
}) {
  const { after } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.review.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="offer-reviews" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  const message = (key: string) => (
    <>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('catalog.review.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`catalog.review.${key}`)}</p>
      )}
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('catalog.review.back-home')}
        </a>
      </p>
    </>
  );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return shell(message('no-access'));
  }
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (typeof after === 'string' && after !== '') query.set('afterId', after);
  const result = await serverGet<ReviewPage>(`catalog/admin/review-queue?${query.toString()}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  return shell(
    <div className="flex flex-col gap-4">
      <ReviewQueue
        rows={result.body.items}
        canDecide={gate.session.permissionKeys.includes(DECIDE_PERMISSION)}
        csrfToken={gate.session.csrfToken}
      />
      {result.body.nextAfterId === null ? null : (
        <p>
          <a
            className="font-medium text-link underline"
            href={`/offer-reviews?after=${encodeURIComponent(result.body.nextAfterId)}`}
          >
            {t('catalog.review.more')}
          </a>
        </p>
      )}
    </div>,
  );
}
