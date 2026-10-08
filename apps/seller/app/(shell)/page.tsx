import { AppShell, Sidebar, Topbar, visibleNavItems } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { UserMenu } from '../../src/auth/user-menu.tsx';
import { sellerNav } from '../../src/nav.ts';
import { readSession } from '../../src/server/session.ts';

export default async function HomePage() {
  const read = await readSession();
  if (read.kind === 'signed-out') {
    // A cookie the API rejected is cleared through /session-ended; no cookie is just not signed in.
    const jar = await cookies();
    const hadSession = jar.getAll().some((c) => c.name.startsWith('__Host-session-seller-'));
    redirect(hadSession ? '/session-ended' : '/sign-in');
  }
  const t = await getTranslations();
  if (read.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  const { session } = read;
  const items = visibleNavItems(sellerNav, new Set(session.permissionKeys));
  return (
    <AppShell
      sidebar={
        <Sidebar
          panelName={t('panel.name')}
          items={items}
          activeId="s_home"
          label={(key) => t(key)}
        />
      }
      topbar={
        <Topbar
          pageTitle={t('home.title')}
          actions={<UserMenu name={session.displayName} csrfToken={session.csrfToken} />}
        />
      }
    >
      <p className="text-fg-muted">{t('home.empty')}</p>
    </AppShell>
  );
}
