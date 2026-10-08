import 'server-only';
import { AppShell, Sidebar, Topbar, visibleNavItems } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { UserMenu } from '../auth/user-menu.tsx';
import { sellerNav } from '../nav.ts';
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
  const approved = session.sellerAccessState === 'approved';
  const items = visibleNavItems(sellerNav, new Set(session.permissionKeys)).filter(
    (item) => !(approved && item.id === 's_setup'),
  );
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
