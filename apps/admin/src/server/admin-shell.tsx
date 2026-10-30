import 'server-only';
import {
  AppShell,
  PageTitle,
  PaletteSearchButton,
  ShortcutsButton,
  PanelTools,
  PinButton,
  NAV_OPEN_COOKIE,
  SIDEBAR_COOKIE,
  Sidebar,
  type Crumb,
  THEME_COOKIE,
  navOpenGroups,
  navTrail,
  Topbar,
  panelToolsLabels,
  sidebarCollapsed,
  themeChoice,
  visibleNavItems,
} from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { UserMenu } from '../auth/user-menu.tsx';
import { adminNav } from '../nav.ts';
import { adminGoShortcuts, adminPaletteEntries } from '../palette.ts';
import { AdminNotifications } from '../notifications/admin-notifications.tsx';
import { showsNoticeBell } from '../notifications/types.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { panelHostFor } from './bff.ts';
import { panelConfig } from './config.ts';
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
  trail,
  children,
}: {
  readonly session: AdminSession;
  readonly activeId: string;
  readonly title: string;
  /** The breadcrumb above the page when it is not the one the active menu item gives. */
  readonly trail?: readonly Crumb[];
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const jar = await cookies();
  const collapsed = sidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value);
  const openGroups = navOpenGroups(jar.get(NAV_OPEN_COOKIE)?.value);
  const items = visibleNavItems(adminNav, new Set(session.permissionKeys));
  const bell = showsNoticeBell(session.permissionKeys);
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const entries = adminPaletteEntries(session.permissionKeys, (key) => t(key));
  return (
    <PanelTools
      panel="admin"
      market={marketId}
      accountId={session.accountId}
      entries={entries}
      goShortcuts={adminGoShortcuts(entries, (key) => t(key))}
      labels={panelToolsLabels((key) => t.raw(key) as string)}
    >
      <StepUpProvider>
        <AppShell
          labels={{
            menu: t('nav.menu'),
            close: t('nav.close'),
            more: t('nav.more'),
            main: t('nav.main'),
            collapse: t('nav.collapse'),
            expand: t('nav.expand'),
            toasts: { region: t('toast.region'), close: t('toast.close') },
          }}
          collapsed={collapsed}
          sidebar={
            <Sidebar
              panelName={t('panel.name')}
              items={items}
              groups={adminNav.groups}
              activeId={activeId}
              label={(key) => t(key)}
              openGroups={openGroups}
              expandAll={t('nav.expandAll')}
              collapseAll={t('nav.collapseAll')}
            />
          }
          topbar={
            <Topbar
              pageTitle={title}
              trail={trail ?? navTrail(items, activeId, title, (key) => t(key), adminNav.groups)}
              trailLabel={t('nav.breadcrumb')}
              phoneTitle={<PageTitle fallback={title} />}
              titleAction={<PinButton />}
              actions={
                <>
                  <ShortcutsButton />
                  <PaletteSearchButton />
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
      </StepUpProvider>
    </PanelTools>
  );
}
