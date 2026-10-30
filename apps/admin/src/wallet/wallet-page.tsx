import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AdminShell } from '../server/admin-shell.tsx';
import { requireSession, type AdminSession } from '../server/session.ts';
import { SettingsShell } from '../server/settings-shell.tsx';

/**
 * The frame of a wallet page: session gate, shell, title and the intro lines, and the no-access
 * message when the admin holds none of `anyOf` (the pattern of the held prices page). The body is
 * built only for an admin who may see the page.
 */
export async function WalletPage({
  activeId,
  title,
  intro,
  anyOf,
  stepUpNote,
  settingsLinkId,
  body,
}: {
  /** The menu item the page belongs to (ignored when the page is a settings page). */
  readonly activeId: string;
  /** Set for a page under Settings (the wallet switch): it then uses the settings shell. */
  readonly settingsLinkId?: string;
  readonly title: string;
  readonly intro: string;
  readonly anyOf: readonly string[];
  /** Show the "wait for a new code" help line (the page has a button that asks for a code). */
  readonly stepUpNote: boolean;
  readonly body: (session: AdminSession, keys: ReadonlySet<string>) => ReactNode;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const keys = new Set(gate.session.permissionKeys);
  const allowed = anyOf.some((key) => keys.has(key));
  const shell = (children: ReactNode) =>
    settingsLinkId === undefined ? (
      <AdminShell session={gate.session} activeId={activeId} title={title}>
        {children}
      </AdminShell>
    ) : (
      <SettingsShell session={gate.session} linkId={settingsLinkId} title={title}>
        {children}
      </SettingsShell>
    );
  if (settingsLinkId !== undefined) {
    // A settings page draws its own header: the body is a `SettingsPage` (title, intro, rows).
    return shell(
      allowed ? (
        body(gate.session, keys)
      ) : (
        <NoAccess
          title={t('settings.no-access-title')}
          body={t('settings.no-access-needs', {
            page: title,
            permission: t('wallet.settings.permission-view'),
          })}
          backHref="/"
          backLabel={t('settings.back-home')}
        />
      ),
    );
  }
  return shell(
    <>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      {allowed ? (
        <div className="flex flex-col gap-4">
          <div className="flex max-w-(--mp-size-form-max) flex-col gap-1 text-fg-muted">
            <p>{intro}</p>
            {stepUpNote ? <p className="text-sm">{t('step-up.wait-note')}</p> : null}
          </div>
          {body(gate.session, keys)}
        </div>
      ) : (
        <>
          <p className="text-fg-muted">{t('wallet.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('wallet.back-home')}
            </a>
          </p>
        </>
      )}
    </>,
  );
}
