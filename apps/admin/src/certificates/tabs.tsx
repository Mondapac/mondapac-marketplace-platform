import { Tabs } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';

export type CertificatesTab = 'queue' | 'issuers' | 'requests';

/**
 * The tabs of the Certificates pages. A tab shows only when the reader holds its permission, and
 * a single tab is not shown at all.
 */
export async function CertificatesTabs({
  active,
  permissionKeys,
}: {
  readonly active: CertificatesTab;
  readonly permissionKeys: readonly string[];
}) {
  const t = await getTranslations('certificates.tabs');
  const items = [
    permissionKeys.includes('certification.seller-certificate.view')
      ? { id: 'queue', label: t('queue'), href: '/certificates' }
      : null,
    permissionKeys.includes('certification.issuer.view')
      ? { id: 'issuers', label: t('issuers'), href: '/certificates/issuers' }
      : null,
    permissionKeys.includes('certification.issuer.view')
      ? { id: 'requests', label: t('requests'), href: '/certificates/issuer-requests' }
      : null,
  ].filter((item) => item !== null);
  if (items.length < 2) return null;
  return <Tabs label={t('label')} activeId={active} items={items} />;
}
