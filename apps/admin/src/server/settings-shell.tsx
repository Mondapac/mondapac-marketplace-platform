import 'server-only';
import { BackLink, type Crumb } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { settingsLink } from '../settings/settings-nav.ts';
import { AdminShell } from './admin-shell.tsx';
import type { AdminSession } from './session.ts';

/**
 * The shell of every page under /settings/*: the admin shell with the sidebar's Settings item
 * active, the breadcrumb Settings / Group / Page, and the way to the other settings pages: a
 * second navigation column (220 px) from 1180 px, a "Back to Settings" link above the heading below it.
 * `linkId` is the page's id in `settingsGroups`.
 */
export async function SettingsShell({
  session,
  linkId,
  title,
  nested = false,
  children,
}: {
  readonly session: AdminSession;
  readonly linkId: string;
  readonly title: string;
  /** True for a page below a settings page (a role editor): the breadcrumb names the parent too. */
  readonly nested?: boolean;
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const found = settingsLink(linkId);
  const trail: Crumb[] = [
    { label: t('nav.home'), href: '/' },
    { label: t('nav.settings'), href: '/settings' },
  ];
  if (found !== undefined) {
    trail.push({ label: t(found.group.labelKey) });
    if (nested) trail.push({ label: t(found.link.labelKey), href: found.link.href });
  }
  return (
    <AdminShell
      session={session}
      activeId="settings"
      title={title}
      trail={trail}
      pinInPage
      settingsLinkId={linkId}
    >
      <div className="mb-2 md:hidden">
        <BackLink href="/settings" label={t('settings.sub.back')} />
      </div>
      {children}
    </AdminShell>
  );
}
