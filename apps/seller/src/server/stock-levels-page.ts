import 'server-only';
import { redirect } from 'next/navigation';
import type { OfferView } from '../catalog/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import type { StockLevelsView } from '../stock/levels-types.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView } from '../stock/types.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type StockLevelsPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly offer: OfferView;
      readonly view: StockLevelsView;
      readonly sources: SourcesView;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session, the offer, its stock levels and the seller's locations for one offer's stock page. */
export async function loadStockLevelsPage(offerId: string): Promise<StockLevelsPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(STOCK_VIEW_PERMISSION))
    return { kind: 'no-access', session };
  const [offer, view, sources] = await Promise.all([
    serverGet<OfferView>(`catalog/seller/offers/${offerId}`),
    serverGet<StockLevelsView>(`inventory/seller/offers/${offerId}/stock`),
    serverGet<SourcesView>('inventory/seller/sources'),
  ]);
  const all = [offer, view, sources];
  if (all.some((item) => item.kind === 'signed-out')) redirect('/session-ended');
  if (all.some((item) => item.kind === 'not-found')) return { kind: 'not-found', session };
  if (offer.kind !== 'ok' || view.kind !== 'ok' || sources.kind !== 'ok') {
    return { kind: 'unavailable' };
  }
  return { kind: 'ok', session, offer: offer.body, view: view.body, sources: sources.body };
}
