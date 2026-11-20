import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { isView, type View } from '../../../../src/blog/list/posts-list-types.ts';
import { PostsList } from '../../../../src/blog/posts-list.tsx';
import { BLOG_EDIT_PERMISSION, BLOG_READ_PERMISSION } from '../../../../src/blog/types.ts';
import { ContentNoAccess } from '../../../../src/content/content-no-access.tsx';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('blog');
  return { title: t('title') };
}

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Blog posts (list 26): the Market's posts as a super list. A link may open a view (`?view=`); the
 * page reads the Market's List paging setting and hands the list its zone, and the list reads its
 * own rows. Writing stays with its own permission: New post shows only for a role that may edit.
 */
export default async function BlogPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly view?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, marketTimezone } = gate.session;
  if (!permissionKeys.includes(BLOG_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} activeId="blog" />;
  }
  const asked = one((await searchParams).view);
  const view: View = isView(asked) ? asked : 'all';
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read (or may not be read) means Previous and next.
  const [mode, host] = await Promise.all([
    serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
    headers(),
  ]);
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), host.get('host'))?.marketId ?? '';
  const title = t('blog.title');
  return (
    <AdminShell session={gate.session} activeId="blog" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <PostsList
        // A link to another view is a fresh list.
        key={view}
        initialView={view}
        paging={paging}
        accountId={gate.session.accountId}
        marketId={marketId}
        zone={localZone(timezone, marketTimezone)}
        canEdit={permissionKeys.includes(BLOG_EDIT_PERMISSION)}
      />
    </AdminShell>
  );
}
