import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { BLOG_READ_PERMISSION, BLOG_TAXONOMY_PERMISSION } from '../../../../../src/blog/types.ts';
import { TaxonomyView } from '../../../../../src/blog/taxonomy/taxonomy-view.tsx';
import { ContentNoAccess } from '../../../../../src/content/content-no-access.tsx';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations('blog.taxonomy');
  return { title: t('title') };
}

export default async function BlogTaxonomyPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, csrfToken } = gate.session;
  if (!permissionKeys.includes(BLOG_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('blog.taxonomy.title');
  return (
    <AdminShell session={gate.session} activeId="blog" title={title}>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('blog.taxonomy.intro')}</p>
      </div>
      <TaxonomyView
        canEdit={permissionKeys.includes(BLOG_TAXONOMY_PERMISSION)}
        csrfToken={csrfToken}
      />
    </AdminShell>
  );
}
