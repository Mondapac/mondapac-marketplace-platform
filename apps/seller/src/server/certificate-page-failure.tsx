import 'server-only';
import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CERTIFICATES_PATH } from '../certificates/types.ts';
import { SettingsNoAccess } from '../settings/settings-no-access.tsx';
import type { CertificatePage } from './certificates-page.ts';
import { SettingsShell } from './settings-shell.tsx';

/**
 * What a certificate's page shows when it cannot show the certificate: the settings shell with the
 * load error, the no-access page, or "gone" with the way back to the list. Shared by the status
 * page, the form and the review page.
 */
export async function CertificatePageFailure({
  page,
  pageTitle,
}: {
  readonly page: Exclude<CertificatePage, { readonly kind: 'ok' }>;
  readonly pageTitle?: string;
}) {
  const t = await getTranslations();
  const listTitle = t('certification.seller.title');
  const crumbs = [{ label: listTitle, href: CERTIFICATES_PATH }];
  const back = { href: CERTIFICATES_PATH, label: t('certification.form.back') };
  if (page.kind === 'unavailable') {
    if (page.session === undefined)
      return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
    return (
      <SettingsShell
        session={page.session}
        linkId="certificates"
        title={listTitle}
        crumbs={crumbs}
        backLink={back}
      >
        <SettingsPage title={pageTitle ?? listTitle}>
          <LoadError
            title={t('certification.form.load-error')}
            message={t('settings.load-error.body')}
            retryLabel={t('load.retry')}
            className="w-full"
          />
        </SettingsPage>
      </SettingsShell>
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SettingsShell session={page.session} linkId="certificates" title={listTitle}>
        <SettingsNoAccess
          pageTitle={listTitle}
          permissionKeys={page.session.permissionKeys}
          title={t('certification.no-access.title')}
          body={t('certification.no-access.body')}
          labels={{ settings: t('settings.sub.back'), home: t('settings.back-home') }}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell
      session={page.session}
      linkId="certificates"
      title={listTitle}
      crumbs={crumbs}
      backLink={back}
    >
      <NoAccess
        pageTitle={listTitle}
        title={t('certification.error.gone')}
        body={t('certification.form.gone-body')}
        backHref={CERTIFICATES_PATH}
        backLabel={t('certification.form.back')}
      />
    </SettingsShell>
  );
}
