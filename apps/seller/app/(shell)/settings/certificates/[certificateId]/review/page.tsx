import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { CertificateReview } from '../../../../../../src/certificates/certificate-review.tsx';
import { opensOnForm } from '../../../../../../src/certificates/status.ts';
import {
  CERTIFICATE_MANAGE_PERMISSION,
  CERTIFICATES_PATH,
  certificatePath,
  typeName,
} from '../../../../../../src/certificates/types.ts';
import { loadCertificatePage } from '../../../../../../src/server/certificates-page.ts';
import { SettingsShell } from '../../../../../../src/server/settings-shell.tsx';
import { SettingsNoAccess } from '../../../../../../src/settings/settings-no-access.tsx';

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
  if (page.kind === 'unavailable') {
    if (page.session === undefined)
      return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
    return (
      <SettingsShell
        session={page.session}
        linkId="certificates"
        title={listTitle}
        crumbs={[{ label: listTitle, href: CERTIFICATES_PATH }]}
        backLink={{ href: CERTIFICATES_PATH, label: t('certification.form.back') }}
      >
        <SettingsPage title={t('certification.review.title')}>
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
        crumbs={[{ label: listTitle, href: CERTIFICATES_PATH }]}
        backLink={{ href: CERTIFICATES_PATH, label: t('certification.form.back') }}
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
  const canManage = page.session.permissionKeys.includes(CERTIFICATE_MANAGE_PERMISSION);
  // Nothing to submit here (view only, a closed type, or a record under review or decided).
  if (!canManage || type === undefined || !opensOnForm(certificate)) {
    redirect(certificatePath(certificate.certificateId));
  }
  const formTitle = t('certification.form.page-title', {
    type: typeName(type.names, certificate.typeCode, locale),
  });
  const formPath = certificatePath(certificate.certificateId);
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
