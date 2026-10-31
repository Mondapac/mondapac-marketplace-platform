import 'server-only';
import { BackLink, SettingsSubNav, type Crumb } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { settingsLink, visibleSettings } from '../settings/settings-nav.ts';
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
  const groups = visibleSettings(session.permissionKeys).map(({ group, links }) => ({
    id: group.id,
    label: t(group.labelKey),
    links: links.map(({ link }) => ({ id: link.id, href: link.href, label: t(link.labelKey) })),
  }));
  return (
    <AdminShell session={session} activeId="settings" title={title} trail={trail} pinInPage>
      <div className="grid grid-cols-1 gap-6 min-[1180px]:grid-cols-[13.75rem_minmax(0,1fr)] min-[1180px]:items-start">
        <div className="hidden min-[1180px]:sticky min-[1180px]:top-[calc(var(--mp-size-topbar)+1.5rem)] min-[1180px]:block min-[1180px]:max-h-[calc(100vh-var(--mp-size-topbar)-3rem)] min-[1180px]:overflow-y-auto">
          <SettingsSubNav label={t('settings.sub.label')} groups={groups} activeId={linkId} />
        </div>
        <div className="min-w-0">
          <div className="mb-2 min-[1180px]:hidden">
            <BackLink href="/settings" label={t('settings.sub.back')} />
          </div>
          {children}
        </div>
      </div>
    </AdminShell>
  );
}
