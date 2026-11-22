import 'server-only';
import { BackLink, type Crumb } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { settingsLink } from '../settings/settings-nav.ts';
import { SellerShell } from './seller-shell.tsx';
import type { SellerSession } from './session.ts';

/**
 * The shell of every page under /settings/*: the seller shell with the sidebar's Settings item
 * active, the breadcrumb Dashboard / Settings / Group / Page, and the way to the other settings
 * pages: a second navigation column (220 px) from 1180 px, a "Back to Settings" link above the heading
 * below it. `linkId` is the page's id in `settingsGroups`.
 */
export async function SettingsShell({
  session,
  linkId,
  title,
  children,
}: {
  readonly session: SellerSession;
  readonly linkId: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const found = settingsLink(linkId);
  const trail: Crumb[] = [
    { label: t('nav.home'), href: '/' },
    { label: t('nav.settings'), href: '/settings' },
  ];
  if (found !== undefined) trail.push({ label: t(found.group.labelKey) });
  return (
    <SellerShell
      session={session}
      activeId="s_settings"
      title={title}
      trail={trail}
      settingsLinkId={linkId}
    >
      <div className="mb-2 md:hidden">
        <BackLink href="/settings" label={t('settings.sub.back')} />
      </div>
      {children}
    </SellerShell>
  );
}
