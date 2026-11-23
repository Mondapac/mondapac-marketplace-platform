import { PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../server/admin-shell.tsx';
import type { AdminSession } from '../server/session.ts';

/** The no-access state of the Content pages, with a way home (as the settings pages do). */
export async function ContentNoAccess({
  session,
  activeId = 'content',
}: {
  readonly session: AdminSession;
  /** The CMS menu item to mark: Pages unless the page belongs to Blog, Slides or Menus. */
  readonly activeId?: 'content' | 'blog' | 'slides' | 'menus';
}) {
  const t = await getTranslations('content');
  return (
    <AdminShell session={session} activeId={activeId} title={t('title')}>
      <PageHeader title={t('no-access.title')} className="mb-2" />
      <p className="text-fg-muted">{t('no-access.body')}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('no-access.action')}
        </a>
      </p>
    </AdminShell>
  );
}
