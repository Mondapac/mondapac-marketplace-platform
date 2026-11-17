import 'server-only';
import {
  AppShell,
  PageTitle,
  PaletteSearchButton,
  ShortcutsButton,
  PanelTools,
  PinButton,
  NAV_OPEN_COOKIE,
  NavBadgeProvider,
  SIDEBAR_COOKIE,
  Sidebar,
  buildSettingsMenuGroups,
  type SettingsMenu,
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
import { CriticalAlertsBadge } from '../security-centre/critical-badge.tsx';
import { VIEW_PERMISSION as SECURITY_VIEW } from '../security-centre/types.ts';
import { showsNoticeBell } from '../notifications/types.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { SystemRequestsNavBadge } from '../system-requests/nav-badge.tsx';
import { VIEW_PERMISSION as SYSTEM_REQUESTS_VIEW } from '../system-requests/types.ts';
import { PanelNavigationProgress } from '../shared/navigation-progress.tsx';
import { panelHostFor } from './bff.ts';
import { settingEntries, visibleSettings } from '../settings/settings-nav.ts';
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
  pinInPage = false,
  settingsLinkId,
  children,
}: {
  readonly session: AdminSession;
  readonly activeId: string;
  readonly title: string;
  /** The breadcrumb above the page when it is not the one the active menu item gives. */
  readonly trail?: readonly Crumb[];
  /**
   * The page draws the pin star beside its own title (settings pages), so the top bar has none.
   */
  readonly pinInPage?: boolean;
  /** Id of the settings page being shown (the sidebar is the Settings menu under /settings). */
  readonly settingsLinkId?: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const settings: SettingsMenu | undefined =
    activeId === 'settings'
      ? {
          groups: buildSettingsMenuGroups(
            visibleSettings(session.permissionKeys),
            settingEntries,
            (key) => t(key),
          ),
          ...(settingsLinkId === undefined ? {} : { activeId: settingsLinkId }),
          backHref: '/',
          backLabel: t('settings.menu.back'),
          searchLabel: t('settings.menu.search'),
          emptyLabel: t('settings.menu.empty'),
          navLabel: t('settings.menu.label'),
        }
      : undefined;
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
        <NavBadgeProvider>
          {/* No view permission, no call: the menu item is hidden and the count is never read. */}
          <SystemRequestsNavBadge enabled={session.permissionKeys.includes(SYSTEM_REQUESTS_VIEW)} />
          <PanelNavigationProgress />
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
                settings={settings}
              />
            }
            topbar={
              <Topbar
                pageTitle={title}
                trail={trail ?? navTrail(items, activeId, title, (key) => t(key), adminNav.groups)}
                trailLabel={t('nav.breadcrumb')}
                phoneTitle={<PageTitle fallback={title} />}
                titleAction={pinInPage ? undefined : <PinButton />}
                actions={
                  <>
                    <ShortcutsButton />
                    <PaletteSearchButton />
                    {session.permissionKeys.includes(SECURITY_VIEW) ? (
                      <CriticalAlertsBadge />
                    ) : null}
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
        </NavBadgeProvider>
      </StepUpProvider>
    </PanelTools>
  );
}
