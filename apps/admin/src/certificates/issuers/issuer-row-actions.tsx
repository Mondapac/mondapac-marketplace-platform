'use client';

import { Menu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

/**
 * The row menu of an issuer. Opening is the only action here (confirmation level 1): closing,
 * derecognising and reactivating need the affected-certificate count and an expert's approval,
 * so they stay on the issuer's page.
 */
export function IssuerRowActions({
  issuerId,
  name,
}: {
  readonly issuerId: string;
  readonly name: string;
}) {
  const t = useTranslations('certificates.issuers');
  const router = useRouter();
  return (
    <Menu
      label={t('actions-for', { name })}
      items={[
        {
          id: 'open',
          label: t('open-issuer'),
          onSelect: () => router.push(`/certificates/issuers/${issuerId}`),
        },
      ]}
    />
  );
}
