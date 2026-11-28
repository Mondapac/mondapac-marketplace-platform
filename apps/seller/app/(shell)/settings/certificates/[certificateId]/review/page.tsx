import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { CertificateReview } from '../../../../../../src/certificates/certificate-review.tsx';
import { formPathOf, opensOnForm } from '../../../../../../src/certificates/status.ts';
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
  return { title: t('certification.review.title') };
}

/**
 * Review and submit one certificate (seller certificates design section 8, CS4). Only a record the
 * seller may still submit opens here; anything else goes back to the certificate's own page.
 */
export default async function CertificateReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly certificateId: string }>;
}) {
  const { certificateId } = await params;
  const t = await getTranslations();
  const locale = await getLocale();
  const page = await loadCertificatePage(certificateId);
  const listTitle = t('certification.seller.title');
  if (page.kind !== 'ok') {
    return <CertificatePageFailure page={page} pageTitle={t('certification.review.title')} />;
  }
  const { certificate } = page.detail;
  const type = page.options.types.find((item) => item.code === certificate.typeCode);
  const canManage = page.session.permissionKeys.includes(CERTIFICATE_MANAGE_PERMISSION);
  // Nothing to submit here (view only, a closed type, or a record under review or decided).
  if (!canManage || type === undefined || !opensOnForm(certificate)) {
    redirect(certificatePath(certificate.certificateId));
  }
  const formTitle = t('certification.form.page-title', {
    type: typeName(type.names, certificate.typeCode, locale),
  });
  const formPath = formPathOf(certificate);
  return (
    <SettingsShell
      session={page.session}
      linkId="certificates"
      title={t('certification.review.title')}
      crumbs={[
        { label: listTitle, href: CERTIFICATES_PATH },
        { label: formTitle, href: formPath },
      ]}
      backLink={{ href: formPath, label: t('certification.review.back') }}
    >
      <CertificateReview
        key={`${certificate.certificateId}:${certificate.lastChangedAt}`}
        detail={page.detail}
        type={type}
        zone={page.zone}
        csrfToken={page.session.csrfToken}
      />
    </SettingsShell>
  );
}
