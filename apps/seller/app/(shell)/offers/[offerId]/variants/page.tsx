import { notFound, permanentRedirect } from 'next/navigation';
import { isUuid } from '../../../../../src/server/catalog-page.ts';

/**
 * The offer's sizes, prices and stock are on the offer page itself (Offer page PR 3); an old link
 * to the Variants tab lands there.
 */
export default async function OfferVariantsPage({
  params,
}: {
  readonly params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  if (!isUuid(offerId)) notFound();
  permanentRedirect(`/offers/${offerId}#sizes`);
}
