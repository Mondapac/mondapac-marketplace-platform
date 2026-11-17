import 'server-only';
import { LoadError, Tabs } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AdminShell } from '../server/admin-shell.tsx';
import type { AdminSession } from '../server/session.ts';

export type SecurityTab = 'alerts' | 'on-call';

/**
 * The frame of the security pages (F1: Audit Logs > Security; F2/F3: two tabs). The tabs are
 * links with aria-current (Reza M6), so each tab has its own address.
 */
export async function SecurityFrame({
  session,
  tab,
  pageTitle,
  children,
}: {
  readonly session: AdminSession;
  readonly tab: SecurityTab | null;
  /** A page below the tabs (one alert) names itself and draws its own heading. */
  readonly pageTitle?: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('security-centre');
  const title = pageTitle ?? t('title');
  return (
    <AdminShell session={session} activeId="security" title={title}>
      {pageTitle === undefined ? (
        <>
          <h1 className="mb-1 text-2xl font-semibold">{title}</h1>
          <p className="mb-4 text-fg-muted">{t('intro')}</p>
        </>
      ) : null}
      {tab === null ? null : (
        <div className="mb-6">
          <Tabs
            label={t('tabs.label')}
            activeId={tab}
            items={[
              { id: 'alerts', label: t('tabs.alerts'), href: '/security/alerts' },
              { id: 'on-call', label: t('tabs.on-call'), href: '/security/on-call' },
            ]}
          />
        </div>
      )}
      {children}
    </AdminShell>
  );
}

/** What a reader without security.centre.view (or after a 403) sees. */
export async function SecurityNoAccess() {
  const t = await getTranslations('security-centre');
  return (
    <>
      <h2 className="text-lg font-semibold">{t('no-access-title')}</h2>
      <p className="mt-1 text-fg-muted">{t('no-access')}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('back-home')}
        </a>
      </p>
    </>
  );
}

/** The server did not answer. */
export async function SecurityUnavailable({ message }: { readonly message: string }) {
  const t = await getTranslations();
  return <LoadError message={message} retryLabel={t('load.retry')} />;
}
