import 'server-only';
import { BackLink, type Crumb } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { settingsLink } from '../settings/settings-nav.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { SellerShell } from './seller-shell.tsx';
import type { SellerSession } from './session.ts';

/**
 * The shell of every page under /settings/*: the seller shell with the sidebar's Settings item
 * active, the breadcrumb Dashboard / Settings / Group / Page, and the way to the other settings
 * pages: a second navigation column (220 px) from 1180 px, a "Back to Settings" link above the heading
 * below it. `linkId` is the page's id in `settingsGroups`.
 *
 * Before approval the seller has no Settings: a page that opens then (`beforeApproval`, the
 * certificates) sits in the limited shell under Account setup, and its way back is the setup.
 * `crumbs` are extra steps after the group (a certificate under Certificates).
 */
export async function SettingsShell({
  session,
  linkId,
  title,
  crumbs = [],
  backLink,
  children,
}: {
  readonly session: SellerSession;
  readonly linkId: string;
  readonly title: string;
  readonly crumbs?: readonly Crumb[];
  /** The phone's way back when it is not "Back to Settings" (a certificate: back to the list). */
  readonly backLink?: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
}) {
  const t = await getTranslations();
  const found = settingsLink(linkId);
  if (session.sellerAccessState !== 'approved') {
    const setupTrail: Crumb[] = [{ label: t('nav.setup'), href: SETUP_ROOT }, ...crumbs];
    const back = backLink ?? { href: SETUP_ROOT, label: t('settings.sub.back-setup') };
    return (
      <SellerShell session={session} activeId="s_setup" title={title} trail={setupTrail}>
        <div className="mb-2">
          <BackLink href={back.href} label={back.label} />
        </div>
        {children}
      </SellerShell>
    );
  }
  const trail: Crumb[] = [
    { label: t('nav.home'), href: '/' },
    { label: t('nav.settings'), href: '/settings' },
  ];
  if (found !== undefined) trail.push({ label: t(found.group.labelKey) });
  trail.push(...crumbs);
  const back = backLink ?? { href: '/settings', label: t('settings.sub.back') };
  return (
    <SellerShell
      session={session}
      activeId="s_settings"
      title={title}
      trail={trail}
      settingsLinkId={linkId}
    >
      <div className={backLink === undefined ? 'mb-2 md:hidden' : 'mb-2'}>
        <BackLink href={back.href} label={back.label} />
      </div>
      {children}
    </SellerShell>
  );
}
