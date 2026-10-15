import 'server-only';
import { AppShell, Sidebar, Topbar } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { UserMenu } from '../auth/user-menu.tsx';
import { sellerNavItems } from '../nav.ts';
import type { SellerSession } from './session.ts';

/** The panel shell around a signed-in page: sidebar, topbar with the account menu. */
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
  const items = sellerNavItems(session.sellerAccessState, session.permissionKeys);
  // Phone bottom bar (IA 4): Home and Catalogue, only when the caller may see both.
  const tabIds = ['s_home', 's_products'];
  const tabs = tabIds.map((id) => items.find((item) => item.id === id));
  const bottomTabs = tabs.every((item) => item !== undefined)
    ? tabs.map((item) => ({
        id: item.id,
        href: item.href,
        label: t(item.labelKey),
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
      }}
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
