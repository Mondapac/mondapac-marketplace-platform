import { AppShell, Sidebar, Topbar, visibleNavItems } from '@mondapac/ui';
import { adminNav } from '../src/nav.ts';
import { t } from '../src/messages.ts';

export default function HomePage() {
  // Permission keys come from the session summary once sign-in lands (next slice).
  const items = visibleNavItems(adminNav, new Set());
  return (
    <AppShell
      sidebar={<Sidebar panelName={t('panel.name')} items={items} activeId="home" label={t} />}
      topbar={<Topbar pageTitle={t('home.title')} />}
    >
      <p className="text-fg-muted">{t('home.empty')}</p>
    </AppShell>
  );
}
