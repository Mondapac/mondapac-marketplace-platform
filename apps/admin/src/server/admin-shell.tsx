import 'server-only';
import { AppShell, Sidebar, Topbar, visibleNavItems } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { UserMenu } from '../auth/user-menu.tsx';
import { adminNav } from '../nav.ts';
import type { AdminSession } from './session.ts';

/** The panel shell around a signed-in page: sidebar and a topbar with the account menu. */
export async function AdminShell({
  session,
  activeId,
  title,
  children,
}: {
  readonly session: AdminSession;
  readonly activeId: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const items = visibleNavItems(adminNav, new Set(session.permissionKeys));
  return (
    <AppShell
      sidebar={
        <Sidebar
          panelName={t('panel.name')}
          items={items}
          activeId={activeId}
          label={(key) => t(key)}
        />
      }
      topbar={
        <Topbar
          pageTitle={title}
          actions={<UserMenu name={session.displayName} csrfToken={session.csrfToken} />}
        />
      }
    >
      {children}
    </AppShell>
  );
}
