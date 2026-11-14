import { LoadError } from '@mondapac/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ReviewView } from '../../../../../../src/blog/review/review-view.tsx';
import {
  BLOG_PAUSE_PERMISSION,
  BLOG_PUBLISH_PERMISSION,
  BLOG_READ_PERMISSION,
  BLOG_REVIEW_PERMISSION,
} from '../../../../../../src/blog/types.ts';
import { displayZone } from '../../../../../../src/shared/format.ts';
import { ContentNoAccess } from '../../../../../../src/content/content-no-access.tsx';
import { AdminShell } from '../../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../../src/server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations('blog.review');
  return { title: t('page-title') };
}

export default async function BlogReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly postId: string }>;
}) {
  const { postId } = await params;
  if (!UUID.test(postId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, csrfToken, timezone } = gate.session;
  if (!permissionKeys.includes(BLOG_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('blog.review.page-title');
  return (
    <AdminShell session={gate.session} activeId="blog" title={title}>
      <h1 className="sr-only">{title}</h1>
      <ReviewView
        postId={postId}
        canReview={permissionKeys.includes(BLOG_REVIEW_PERMISSION)}
        canPublish={permissionKeys.includes(BLOG_PUBLISH_PERMISSION)}
        canPause={permissionKeys.includes(BLOG_PAUSE_PERMISSION)}
        zone={displayZone(timezone)}
        csrfToken={csrfToken}
      />
    </AdminShell>
  );
}
