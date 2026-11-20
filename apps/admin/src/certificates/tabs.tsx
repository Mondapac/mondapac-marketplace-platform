import { Tabs } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { serverGet } from '../server/server-fetch.ts';
import { API_REQUESTS, type RequestPage } from './requests/types.ts';

export type CertificatesTab = 'queue' | 'issuers' | 'requests' | 'types';

/**
 * The tabs of the Certificates pages. A tab shows only when the reader holds its permission, and
 * a single tab is not shown at all. The Issuer requests tab carries the number of open requests
 * when there are any; `requestCount` skips the read on the page that already has the total, and a
 * failed read shows the plain label.
 */
export async function CertificatesTabs({
  active,
  permissionKeys,
  requestCount,
}: {
  readonly active: CertificatesTab;
  readonly permissionKeys: readonly string[];
  readonly requestCount?: number;
}) {
  const t = await getTranslations('certificates.tabs');
  const seesRequests = permissionKeys.includes('certification.issuer.view');
  let open = requestCount ?? 0;
  if (seesRequests && requestCount === undefined) {
    const result = await serverGet<RequestPage>(`${API_REQUESTS}?limit=1`);
    if (result.kind === 'ok') open = result.body.total;
  }
  const items = [
    permissionKeys.includes('certification.seller-certificate.view')
      ? { id: 'queue', label: t('queue'), href: '/certificates' }
      : null,
    permissionKeys.includes('certification.issuer.view')
      ? { id: 'issuers', label: t('issuers'), href: '/certificates/issuers' }
      : null,
    permissionKeys.includes('certification.issuer.view')
      ? {
          id: 'requests',
          label: open > 0 ? t('requests-open', { count: open }) : t('requests'),
          href: '/certificates/issuer-requests',
        }
      : null,
    permissionKeys.includes('certification.type.view')
      ? { id: 'types', label: t('types'), href: '/certificates/types' }
      : null,
  ].filter((item) => item !== null);
  if (items.length < 2) return null;
  return <Tabs label={t('label')} activeId={active} items={items} />;
}
