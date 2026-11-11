import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { PostsView } from '../../../../src/blog/posts-view.tsx';
import { BLOG_READ_PERMISSION } from '../../../../src/blog/types.ts';
import { ContentNoAccess } from '../../../../src/content/content-no-access.tsx';
import { ContentTabs } from '../../../../src/content/content-tabs.tsx';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { displayZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('blog');
  return { title: t('title') };
}

export default async function BlogPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone } = gate.session;
  if (!permissionKeys.includes(BLOG_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('blog.title');
  return (
    <AdminShell session={gate.session} activeId="blog" title={title}>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('blog.intro')}</p>
      </div>
      <ContentTabs
        active="blog"
        permissionKeys={permissionKeys}
        labels={{
          nav: t('content.tabs.label'),
          slides: t('content.tabs.slides'),
          blog: t('content.tabs.blog'),
        }}
      />
      <PostsView zone={displayZone(timezone)} />
    </AdminShell>
  );
}
