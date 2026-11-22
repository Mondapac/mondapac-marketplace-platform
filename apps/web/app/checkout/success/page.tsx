import { getTranslations } from 'next-intl/server';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { HostedPaymentDone, PaymentNotCompleted } from '../../../src/checkout/payment-result.tsx';
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

/**
 * Where Stripe returns after a payment (the API's success URL, for the hosted page and for a card
 * bank check). The URL proves nothing, so the page never says the payment went through: the order
 * is confirmed by Stripe's signed event and then shows in the buyer's orders.
 */
export default async function HostedSuccessRoute({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const params = await searchParams;
  // Stripe also returns here after a bank check (3D Secure) done as a full-page redirect, with
  // `redirect_status`: anything but `succeeded` means the card was not authorised.
  const status = params.redirect_status;
  if (status !== undefined && status !== 'succeeded') return <PaymentNotCompleted />;
  const order = params.order;
  const reference = typeof order === 'string' && isOrderId(order) ? orderReference(order) : null;
  return <HostedPaymentDone reference={reference} />;
}
