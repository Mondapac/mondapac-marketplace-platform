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
} from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { UserMenu } from '../auth/user-menu.tsx';
import { sellerNavItems } from '../nav.ts';
import { SellerNotifications } from '../notifications/seller-notifications.tsx';
import { NOTICES_PERMISSION } from '../notifications/types.ts';
import type { SellerSession } from './session.ts';

/**
 * The panel shell around a signed-in page: sidebar, topbar with the notifications bell and the
 * account menu. The bell is for an approved seller's members who may see orders, since order
 * notices are the only kind yet and the API refuses notices before approval.
 */
export async function SellerShell({
  session,
  activeId,
  title,
  children,
}: {
  readonly session: SellerSession;
  readonly activeId: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const jar = await cookies();
  const collapsed = sidebarCollapsed(jar.get(SIDEBAR_COOKIE)?.value);
  const items = sellerNavItems(session.sellerAccessState, session.permissionKeys);
  // Phone bottom bar (IA 4): Home and Catalogue, only when the caller may see both.
  const tabIds = ['s_home', 's_products'];
  const tabs = tabIds.map((id) => items.find((item) => item.id === id));
  const bell =
    session.sellerAccessState === 'approved' && session.permissionKeys.includes(NOTICES_PERMISSION);
  const bottomTabs = tabs.every((item) => item !== undefined)
    ? tabs.map((item) => ({
        id: item.id,
        href: item.href,
        label: t(item.labelKey),
        icon: item.icon,
        active: item.id === activeId,
      }))
    : undefined;
  return (
    <AppShell
      bottomTabs={bottomTabs}
      moreActive={bottomTabs?.every((tab) => !tab.active)}
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
              {bell ? <SellerNotifications csrfToken={session.csrfToken} /> : null}
              <UserMenu
                name={session.displayName}
                email={session.email}
                theme={themeChoice(jar.get(THEME_COOKIE)?.value)}
                approved={session.sellerAccessState === 'approved'}
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
