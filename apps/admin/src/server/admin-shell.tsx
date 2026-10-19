import 'server-only';
import {
  AppShell,
  SIDEBAR_COOKIE,
  Sidebar,
  THEME_COOKIE,
  navTrail,
  Topbar,
  sidebarCollapsed,
  themeChoice,
  visibleNavItems,
} from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { UserMenu } from '../auth/user-menu.tsx';
import { adminNav } from '../nav.ts';
import { AdminNotifications } from '../notifications/admin-notifications.tsx';
import { showsNoticeBell } from '../notifications/types.ts';
import type { AdminSession } from './session.ts';

/**
 * The panel shell around a signed-in page: sidebar, and a topbar with the notifications bell and
 * the account menu. The bell is shown only to an admin who holds a permission behind one of the
 * approval notice kinds; the API lists each notice only to holders of its own permission.
 */
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
  const jar = await cookies();
  const collapsed = sidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value);
  const items = visibleNavItems(adminNav, new Set(session.permissionKeys));
  const bell = showsNoticeBell(session.permissionKeys);
  return (
    <AppShell
      labels={{
        menu: t('nav.menu'),
        close: t('nav.close'),
        more: t('nav.more'),
        main: t('nav.main'),
        collapse: t('nav.collapse'),
        expand: t('nav.expand'),
      }}
      collapsed={collapsed}
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
          trail={navTrail(items, activeId, title, (key) => t(key))}
          trailLabel={t('nav.breadcrumb')}
          actions={
            <>
              {bell ? <AdminNotifications csrfToken={session.csrfToken} /> : null}
              <UserMenu
                name={session.displayName}
                email={session.email}
                theme={themeChoice(jar.get(THEME_COOKIE)?.value)}
                csrfToken={session.csrfToken}
              />
            </>
          }
        />
      }
    >
      {children}
    </AppShell>
  );
}
