import 'server-only';
import { LoadError, SettingsTitle } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SettingsNoAccess } from '../settings/settings-no-access.tsx';
import { SETUP_ROOT } from '../setup/steps.ts';
import { SettingsShell } from './settings-shell.tsx';
import { requireSession, type SellerSession } from './session.ts';

/**
 * A settings page of the customers group: the session, the approval redirect, the no-access block
 * when none of `viewKeys` is held, and the shell with the page title. `render` gets the session
 * once access is known; the API checks every call again.
 */
export async function customersSettingsPage({
  linkId,
  titleKey,
  noAccessKey,
  viewKeys,
  render,
}: {
  readonly linkId: string;
  readonly titleKey: string;
  readonly noAccessKey: string;
  readonly viewKeys: readonly string[];
  readonly render: (session: SellerSession) => ReactNode;
}): Promise<ReactNode> {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  // Settings are for an approved seller; the others finish their file first.
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const title = t(titleKey);
  if (!viewKeys.some((key) => session.permissionKeys.includes(key))) {
    return (
      <SettingsShell session={session} linkId={linkId} title={title}>
        <SettingsNoAccess
          permissionKeys={session.permissionKeys}
          title={t(`${noAccessKey}.title`)}
          body={t(`${noAccessKey}.body`)}
          pageTitle={title}
          labels={{ settings: t('settings.sub.back'), home: t('settings.back-home') }}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell session={session} linkId={linkId} title={title}>
      <div className="mb-4">
        <SettingsTitle>{title}</SettingsTitle>
      </div>
      {render(session)}
    </SettingsShell>
  );
}
