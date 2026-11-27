import { getLocale, getTranslations } from 'next-intl/server';
import { CertificateForm } from '../../../../../src/certificates/certificate-form.tsx';
import { CertificateStatusPage } from '../../../../../src/certificates/certificate-status.tsx';
import { isDraftStatus } from '../../../../../src/certificates/status.ts';
import {
  CERTIFICATE_MANAGE_PERMISSION,
  CERTIFICATES_PATH,
  typeName,
} from '../../../../../src/certificates/types.ts';
import { CertificatePageFailure } from '../../../../../src/server/certificate-page-failure.tsx';
import { loadCertificatePage } from '../../../../../src/server/certificates-page.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certification.seller.title') };
}

/**
 * One certificate (seller certificates design sections 7 and 9): a draft opens on its form (CS3);
 * every other status on the status page (CS5), whose buttons lead to the form at `edit`.
 */
export default async function CertificatePage({
  params,
}: {
  readonly params: Promise<{ readonly certificateId: string }>;
}) {
  const { certificateId } = await params;
  const t = await getTranslations();
  const locale = await getLocale();
  const page = await loadCertificatePage(certificateId);
  if (page.kind !== 'ok') return <CertificatePageFailure page={page} />;
  const listTitle = t('certification.seller.title');
  const { certificate } = page.detail;
  const type = page.options.types.find((item) => item.code === certificate.typeCode);
  const title = t('certification.form.page-title', {
    type: typeName(type?.names, certificate.typeCode, locale),
  });
  const canManage = page.session.permissionKeys.includes(CERTIFICATE_MANAGE_PERMISSION);
  return (
    <SettingsShell
      session={page.session}
      linkId="certificates"
      title={title}
      crumbs={[{ label: listTitle, href: CERTIFICATES_PATH }]}
      backLink={{ href: CERTIFICATES_PATH, label: t('certification.form.back') }}
    >
      {isDraftStatus(certificate.status) ? (
        <CertificateForm
          key={`${certificate.certificateId}:${certificate.lastChangedAt}`}
          detail={page.detail}
          type={type}
          canManage={canManage}
          zone={page.zone}
          limits={page.options.documentLimits}
          csrfToken={page.session.csrfToken}
        />
      ) : (
        <CertificateStatusPage
          key={`${certificate.certificateId}:${certificate.lastChangedAt}`}
          detail={page.detail}
          type={type}
          canManage={canManage}
          account={page.account}
          zone={page.zone}
          csrfToken={page.session.csrfToken}
        />
      )}
    </SettingsShell>
  );
}
