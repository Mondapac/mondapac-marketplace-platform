import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { OrderDetails } from '../../../../../src/account/order-details.tsx';
import { pageMetadata, seoDescription } from '../../../../../src/seo/metadata.ts';
import { loadAccount } from '../../../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const [{ id }, t] = await Promise.all([params, getTranslations('account.order')]);
  return pageMetadata({
    name: t('title', { reference: id }),
    description: await seoDescription('account-order', { reference: id }),
    path: `/account/orders/${encodeURIComponent(id)}`,
    noindex: true,
  });
}

export default async function OrderDetailsPage({ params }: Props) {
  const { id } = await params;
  const account = await loadAccount();
  if (!account.orders.some((o) => o.reference === id)) notFound();
  return <OrderDetails reference={id} />;
}
