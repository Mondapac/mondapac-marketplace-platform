import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { CertificateForm } from '../../../../../src/certificates/certificate-form.tsx';
import {
  CERTIFICATE_MANAGE_PERMISSION,
  CERTIFICATES_PATH,
  typeName,
} from '../../../../../src/certificates/types.ts';
import { loadCertificatePage } from '../../../../../src/server/certificates-page.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';
import { SettingsNoAccess } from '../../../../../src/settings/settings-no-access.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certification.seller.title') };
}

/** One certificate's form (seller certificates design section 7, CS3). */
export default async function CertificatePage({
  params,
}: {
  readonly params: Promise<{ readonly certificateId: string }>;
}) {
  const { certificateId } = await params;
  const t = await getTranslations();
  const locale = await getLocale();
  const page = await loadCertificatePage(certificateId);
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
        <SettingsPage title={listTitle}>
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
  if (page.kind === 'not-found') {
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
  const { certificate } = page.detail;
  const type = page.options.types.find((item) => item.code === certificate.typeCode);
  const title = t('certification.form.page-title', {
    type: typeName(type?.names, certificate.typeCode, locale),
  });
  return (
    <SettingsShell
      session={page.session}
      linkId="certificates"
      title={title}
      crumbs={crumbs}
      backLink={back}
    >
      <CertificateForm
        key={`${certificate.certificateId}:${certificate.lastChangedAt}`}
        detail={page.detail}
        type={type}
        canManage={page.session.permissionKeys.includes(CERTIFICATE_MANAGE_PERMISSION)}
        zone={page.zone}
        csrfToken={page.session.csrfToken}
      />
    </SettingsShell>
  );
}
