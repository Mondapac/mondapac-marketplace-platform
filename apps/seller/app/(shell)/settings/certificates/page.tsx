import { LoadError, SettingsPage } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CertificatesList } from '../../../../src/certificates/certificates-list.tsx';
import { CERTIFICATE_MANAGE_PERMISSION } from '../../../../src/certificates/types.ts';
import { loadCertificatesListPage } from '../../../../src/server/certificates-page.ts';
import { readSellerZone } from '../../../../src/server/seller-zone.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { SettingsNoAccess } from '../../../../src/settings/settings-no-access.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certification.seller.title') };
}

/** Settings › Store › Certificates (seller certificates design section 5, CS1). */
export default async function CertificatesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly add?: string | string[] }>;
}) {
  // "Add a certificate" from a declined or revoked certificate opens the start dialog here.
  const { add } = await searchParams;
  const t = await getTranslations();
  const page = await loadCertificatesListPage();
  const title = t('certification.seller.title');
  if (page.kind === 'unavailable') {
    if (page.session === undefined)
      return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
    return (
      <SettingsShell session={page.session} linkId="certificates" title={title}>
        <SettingsPage title={title}>
          <LoadError
            title={t('certification.seller.load-error')}
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
      <SettingsShell session={page.session} linkId="certificates" title={title}>
        <SettingsNoAccess
          pageTitle={title}
          permissionKeys={page.session.permissionKeys}
          title={t('certification.no-access.title')}
          body={t('certification.no-access.body')}
          labels={{ settings: t('settings.sub.back'), home: t('settings.back-home') }}
        />
      </SettingsShell>
    );
  }
  const zone = await readSellerZone();
  return (
    <SettingsShell session={page.session} linkId="certificates" title={title}>
      <CertificatesList
        list={page.list}
        options={page.options}
        account={page.account}
        canManage={page.session.permissionKeys.includes(CERTIFICATE_MANAGE_PERMISSION)}
        zone={zone}
        csrfToken={page.session.csrfToken}
        startOpen={add === '1'}
      />
    </SettingsShell>
  );
}
