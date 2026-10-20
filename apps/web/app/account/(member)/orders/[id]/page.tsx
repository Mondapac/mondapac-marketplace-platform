import { notFound } from 'next/navigation';
import { OrderDetails } from '../../../../../src/account/order-details.tsx';
import { loadAccount } from '../../../../../src/storefront/source.ts';

export default async function OrderDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await loadAccount();
  if (!account.orders.some((o) => o.reference === id)) notFound();
  return <OrderDetails reference={id} />;
}
