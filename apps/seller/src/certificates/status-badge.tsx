import { Badge, Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { statusLook } from './status.ts';

/** A certificate's status: an icon and a word, never colour alone (design section 11). */
export function CertificateStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations();
  const look = statusLook(status);
  return (
    <Badge tone={look.tone}>
      <Icon name={look.icon} />
      {t(look.labelKey)}
    </Badge>
  );
}
