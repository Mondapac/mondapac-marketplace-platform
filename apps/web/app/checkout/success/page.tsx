import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { HostedPaymentDone } from '../../../src/checkout/payment-result.tsx';
import { isOrderId, orderReference } from '../../../src/account/live-orders.ts';

export async function generateMetadata() {
  const [t, description] = await Promise.all([
    getTranslations('checkout'),
    seoDescription('confirmation'),
  ]);
  return pageMetadata({
    name: t('title'),
    description,
    path: '/checkout/success',
    noindex: true,
  });
}

/** Where Stripe's hosted page returns after a payment (the API's success URL). */
export default async function HostedSuccessRoute({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const order = (await searchParams).order;
  const reference = typeof order === 'string' && isOrderId(order) ? orderReference(order) : null;
  return <HostedPaymentDone reference={reference} />;
}
