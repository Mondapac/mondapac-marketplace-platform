import { AccountOrders } from '../../../../src/account/orders.tsx';
import { accountMetadata } from '../../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('orders', '/account/orders');

export default function AccountOrdersPage() {
  return <AccountOrders />;
}
