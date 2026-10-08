import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../src/server/admin-shell.tsx';
import { requireSession } from '../../src/server/session.ts';

export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  return (
    <AdminShell session={gate.session} activeId="home" title={t('home.title')}>
      <p className="text-fg-muted">{t('home.empty')}</p>
    </AdminShell>
  );
}
