import { Badge, Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { SellerCustomerRow } from './types.ts';

/**
 * The badges of a customer: Buyer, Follower and Exclusive. Each has a word and an icon, so status
 * is never carried by colour alone.
 */
export function CustomerBadges({
  customer,
}: {
  readonly customer: Pick<SellerCustomerRow, 'orderCount' | 'follower' | 'exclusive'>;
}) {
  const t = useTranslations('customers.badge');
  const items = [
    ...(customer.orderCount > 0 ? [{ id: 'buyer', icon: 'package', tone: 'info' } as const] : []),
    ...(customer.follower ? [{ id: 'follower', icon: 'star', tone: 'neutral' } as const] : []),
    ...(customer.exclusive
      ? [{ id: 'exclusive', icon: 'shield-check', tone: 'success' } as const]
      : []),
  ];
  if (items.length === 0) return <span aria-hidden="true">-</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item.id} tone={item.tone}>
          <Icon name={item.icon} />
          {t(item.id)}
        </Badge>
      ))}
    </span>
  );
}
