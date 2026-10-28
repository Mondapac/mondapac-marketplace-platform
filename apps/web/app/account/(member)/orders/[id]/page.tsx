import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { OrderDetails } from '../../../../../src/account/order-details.tsx';
import { orderReference } from '../../../../../src/account/live-orders.ts';
import { pageMetadata, seoDescription } from '../../../../../src/seo/metadata.ts';
import { loadAccount, loadAccountOrder } from '../../../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const [{ id }, t] = await Promise.all([params, getTranslations('account.order')]);
  // A real order's page key is its id; the buyer knows it by its reference.
  const reference = /^[0-9a-f]{8}-/iu.test(id) ? orderReference(id) : id;
  return pageMetadata({
    name: t('title', { reference }),
    description: await seoDescription('account-order', { reference }),
    path: `/account/orders/${encodeURIComponent(id)}`,
    noindex: true,
  });
}

export default async function OrderDetailsPage({ params }: Props) {
  const { id } = await params;
  const order = await loadAccountOrder(id);
  if (order === 'sample') {
    const account = await loadAccount();
    if (!account.orders.some((o) => o.reference === id)) notFound();
    return <OrderDetails reference={id} />;
  }
  if (order === null) notFound();
  return <OrderDetails reference={id} order={order} />;
}
