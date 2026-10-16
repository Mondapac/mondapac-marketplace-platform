import { LoadError, ShortcutGrid, visibleNavItems } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { adminNav } from '../../src/nav.ts';
import { AdminShell } from '../../src/server/admin-shell.tsx';
import { requireSession } from '../../src/server/session.ts';

export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  return (
    <AdminShell session={gate.session} activeId="home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="break-words text-2xl font-semibold">
            {t('home.welcome', { name: gate.session.displayName })}
          </h1>
          <p className="text-fg-muted">{t('home.intro')}</p>
        </div>
        {/* The sections this person may open, as in the menu. */}
        <ShortcutGrid
          label={t('home.shortcuts')}
          items={visibleNavItems(adminNav, new Set(gate.session.permissionKeys))
            .filter((item) => item.id !== 'home')
            .map((item) => {
              const key = item.labelKey.replace(/^nav\./, '');
              return {
                id: item.id,
                href: item.href,
                icon: item.icon,
                title: t(item.labelKey),
                body: t(`home.shortcut.${key}`),
              };
            })}
        />
      </div>
    </AdminShell>
  );
}
