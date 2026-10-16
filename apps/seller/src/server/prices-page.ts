import 'server-only';
import { redirect } from 'next/navigation';
import type { OfferView } from '../catalog/types.ts';
import { PRICE_VIEW_PERMISSION, type OfferPricesView } from '../price/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { readSellerZone } from './seller-zone.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type PricesPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly offer: OfferView;
      readonly view: OfferPricesView;
      /** The seller's own IANA zone, or null when it could not be read (times then show in UTC). */
      readonly zone: string | null;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session, the offer and its prices for one offer's price page. */
export async function loadPricesPage(offerId: string): Promise<PricesPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(PRICE_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const [offer, view, zone] = await Promise.all([
    serverGet<OfferView>(`catalog/seller/offers/${offerId}`),
    serverGet<OfferPricesView>(`pricing/seller/offers/${offerId}/prices`),
    readSellerZone(),
  ]);
  if (offer.kind === 'signed-out' || view.kind === 'signed-out') redirect('/session-ended');
  if (offer.kind === 'not-found' || view.kind === 'not-found')
    return { kind: 'not-found', session };
  if (offer.kind !== 'ok' || view.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    session,
    offer: offer.body,
    view: view.body,
    zone,
  };
}
