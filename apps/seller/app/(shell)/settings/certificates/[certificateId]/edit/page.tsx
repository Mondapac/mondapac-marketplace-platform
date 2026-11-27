import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { CertificateForm } from '../../../../../../src/certificates/certificate-form.tsx';
import { formModeOf, isDraftStatus } from '../../../../../../src/certificates/status.ts';
import {
  CERTIFICATE_MANAGE_PERMISSION,
  CERTIFICATES_PATH,
  certificatePath,
  typeName,
} from '../../../../../../src/certificates/types.ts';
import { CertificatePageFailure } from '../../../../../../src/server/certificate-page-failure.tsx';
import { loadCertificatePage } from '../../../../../../src/server/certificates-page.ts';
import { SettingsShell } from '../../../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certification.seller.title') };
}

/**
 * The form of a certificate that is no longer a draft (design 7.2): a correction, a renewal, a
 * replacement, or an edit while it is under review (the first change withdraws the submission,
 * after the seller confirms). A record that takes no changes goes back to its status page.
 */
export default async function CertificateEditPage({
  params,
}: {
  readonly params: Promise<{ readonly certificateId: string }>;
}) {
  const { certificateId } = await params;
  const t = await getTranslations();
  const locale = await getLocale();
  const page = await loadCertificatePage(certificateId);
  if (page.kind !== 'ok') return <CertificatePageFailure page={page} />;
  const { certificate } = page.detail;
  const type = page.options.types.find((item) => item.code === certificate.typeCode);
  const canManage = page.session.permissionKeys.includes(CERTIFICATE_MANAGE_PERMISSION);
  const statusPath = certificatePath(certificate.certificateId);
  if (isDraftStatus(certificate.status) || !canManage || formModeOf(certificate) === null) {
    redirect(statusPath);
  }
  const listTitle = t('certification.seller.title');
  const title = t('certification.form.page-title', {
    type: typeName(type?.names, certificate.typeCode, locale),
  });
  return (
    <SettingsShell
      session={page.session}
      linkId="certificates"
      title={title}
      crumbs={[{ label: listTitle, href: CERTIFICATES_PATH }]}
      backLink={{ href: statusPath, label: t('certification.form.back-status') }}
    >
      <CertificateForm
        key={`${certificate.certificateId}:${certificate.lastChangedAt}`}
        detail={page.detail}
        type={type}
        canManage={canManage}
        zone={page.zone}
        limits={page.options.documentLimits}
        csrfToken={page.session.csrfToken}
      />
    </SettingsShell>
  );
}
