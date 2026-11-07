import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { revisionHref } from '../../../../../../../src/catalog/review-queue-params.ts';
import {
  DECIDE_PERMISSION,
  TAKE_DOWN_PERMISSION,
  VIEW_PERMISSION,
  type QueuePage,
  type RevisionRow,
} from '../../../../../../../src/catalog/types.ts';
import type {
  RevisionImageList,
  RevisionRead,
} from '../../../../../../../src/catalog/version-review/types.ts';
import { VersionReview } from '../../../../../../../src/catalog/version-review/version-review.tsx';
import { AdminShell } from '../../../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../../../src/server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_VIEW = 'catalog.category-tree.view';

interface CategoryTree {
  readonly categories: readonly {
    readonly id: string;
    readonly names: readonly { readonly locale: string; readonly name: string }[];
  }[];
}

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.version.title') };
}

/**
 * One product version under review (product version review design, screen 2). Reads the version
 * with its published one, its photos, the category names (when the reviewer may read the tree)
 * and the next pending version of the queue; the decisions and takedowns are the client's.
 */
export default async function VersionReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly productId: string; readonly revisionId: string }>;
}) {
  const { productId, revisionId } = await params;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.version.title');
  const shell = (body: React.ReactNode, heading = true) => (
    <AdminShell session={gate.session} activeId="review-queue" title={title}>
      {heading ? <h1 className="mb-4 text-2xl font-semibold">{title}</h1> : null}
      {body}
    </AdminShell>
  );
  const message = (text: string) =>
    shell(
      <>
        <p className="text-fg-muted">{text}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/review">
            {t('catalog.version.decision.back-to-queue')}
          </a>
        </p>
      </>,
    );
  const keys = gate.session.permissionKeys;
  if (!keys.includes(VIEW_PERMISSION)) return message(t('catalog.queue.no-access'));
  if (!UUID.test(productId) || !UUID.test(revisionId)) {
    return message(t('catalog.version.not-found'));
  }

  const base = `catalog/admin/products/${productId}/revisions/${revisionId}`;
  const read = await serverGet<RevisionRead>(base);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind === 'forbidden') return message(t('catalog.queue.no-access'));
  if (read.kind === 'not-found') return message(t('catalog.version.not-found'));
  if (read.kind !== 'ok') {
    return shell(
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('catalog.version.unavailable')}
        retryLabel={t('load.retry')}
      />,
    );
  }

  const locale = await getLocale();
  const [images, tree, queue] = await Promise.all([
    serverGet<RevisionImageList>(`${base}/images`),
    keys.includes(CATEGORY_VIEW)
      ? serverGet<CategoryTree>('catalog/admin/categories')
      : Promise.resolve(null),
    read.body.state === 'pending'
      ? serverGet<QueuePage<RevisionRow>>(
          'catalog/admin/review-queue?kind=product-revision&limit=2',
        )
      : Promise.resolve(null),
  ]);
  if (images.kind === 'signed-out') redirect('/session-ended');
  const categoryNames: Record<string, string> = {};
  if (tree?.kind === 'ok') {
    for (const category of tree.body.categories) {
      const name =
        category.names.find((entry) => entry.locale === locale)?.name ?? category.names[0]?.name;
      if (name !== undefined) categoryNames[category.id] = name;
    }
  }
  const next =
    queue?.kind === 'ok'
      ? queue.body.items.find((row) => row.revisionId !== revisionId)
      : undefined;

  return shell(
    <VersionReview
      read={read.body}
      images={images.kind === 'ok' ? images.body.images : null}
      categoryNames={categoryNames}
      canDecide={keys.includes(DECIDE_PERMISSION)}
      canTakeDown={keys.includes(TAKE_DOWN_PERMISSION)}
      csrfToken={gate.session.csrfToken}
      nextHref={next === undefined ? null : revisionHref(next)}
    />,
    false,
  );
}
