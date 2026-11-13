import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { NewPostForm } from '../../../../../src/blog/editor/new-post-form.tsx';
import { BLOG_EDIT_PERMISSION } from '../../../../../src/blog/types.ts';
import { ContentNoAccess } from '../../../../../src/content/content-no-access.tsx';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations('blog.editor');
  return { title: t('new.title') };
}

export default async function NewBlogPostPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  if (!gate.session.permissionKeys.includes(BLOG_EDIT_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('blog.editor.new.title');
  return (
    <AdminShell session={gate.session} activeId="blog" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <NewPostForm csrfToken={gate.session.csrfToken} />
    </AdminShell>
  );
}
