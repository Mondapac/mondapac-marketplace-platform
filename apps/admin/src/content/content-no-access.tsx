import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../server/admin-shell.tsx';
import type { AdminSession } from '../server/session.ts';

/** The no-access state of the Content pages, with a way home (as the settings pages do). */
export async function ContentNoAccess({ session }: { readonly session: AdminSession }) {
  const t = await getTranslations('content');
  return (
    <AdminShell session={session} activeId="content" title={t('title')}>
      <h1 className="mb-2 text-2xl font-semibold">{t('no-access.title')}</h1>
      <p className="text-fg-muted">{t('no-access.body')}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('no-access.action')}
        </a>
      </p>
    </AdminShell>
  );
}
