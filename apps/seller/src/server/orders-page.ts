import 'server-only';
import { getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { VIEW_PERMISSION, type OfferView, type ProductView } from '../catalog/types.ts';
import { variantLabelOf } from '../orders/labels.ts';
import {
  ORDER_VIEW_PERMISSION,
  OWN_FEE_PERMISSION,
  type LineLabels,
  type OwnFee,
  type SellerOrderPage,
  type SellerOrderView,
} from '../orders/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type OrdersPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly page: SellerOrderPage;
      /** Null when the platform has not set a fee yet, or the role cannot see it. */
      readonly fee: OwnFee | null;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session, the first page of paid orders and the seller's delivery fee. */
export async function loadOrdersPage(): Promise<OrdersPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const canSeeFee = session.permissionKeys.includes(OWN_FEE_PERMISSION);
  const [orders, fee] = await Promise.all([
    serverGet<SellerOrderPage>('ordering/seller/orders?limit=20'),
    canSeeFee ? serverGet<OwnFee>('shipping/seller/flat-fee') : Promise.resolve(null),
  ]);
  if (orders.kind === 'signed-out' || fee?.kind === 'signed-out') redirect('/session-ended');
  if (orders.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    session,
    page: orders.body,
    fee: fee?.kind === 'ok' ? fee.body : null,
  };
}

export type OrderDetailPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly order: SellerOrderView;
      readonly labels: LineLabels;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/**
 * Product name and variant for each line of one order, from the seller's own offers and products.
 * The reads are one per distinct offer and one per distinct product (never one per line), all in
 * parallel. The API has no batch read for offers, so an order of many different products makes
 * that many reads. A name that cannot be read is left out and the screen shows a short id.
 * The variant comes from the seller's own product read, which answers only for products the
 * seller owns; an offer on a platform product shows its name without a variant until the API
 * offers a seller-readable variant label.
 */
export async function loadLineLabels(order: SellerOrderView): Promise<LineLabels> {
  const locale = await getLocale();
  const offerIds = [...new Set(order.lines.map((line) => line.offerId))];
  const offers = new Map<string, OfferView>();
  await Promise.all(
    offerIds.map(async (id) => {
      const result = await serverGet<OfferView>(`catalog/seller/offers/${id}`);
      if (result.kind === 'ok') offers.set(id, result.body);
    }),
  );
  const productIds = [...new Set([...offers.values()].map((offer) => offer.productId))];
  const products = new Map<string, ProductView>();
  await Promise.all(
    productIds.map(async (id) => {
      const result = await serverGet<ProductView>(`catalog/seller/products/${id}`);
      if (result.kind === 'ok') products.set(id, result.body);
    }),
  );
  const labels: Record<string, { name: string | null; variant: string | null }> = {};
  for (const line of order.lines) {
    const offer = offers.get(line.offerId);
    const product = offer === undefined ? undefined : products.get(offer.productId);
    labels[line.lineId] = {
      name: offer?.product.name ?? offer?.product.productCode ?? null,
      variant: product === undefined ? null : variantLabelOf(product, line.variantId, locale),
    };
  }
  return labels;
}

/** The session, one paid order and the names of its lines. */
export async function loadOrderDetailPage(sellerOrderId: string): Promise<OrderDetailPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const result = await serverGet<SellerOrderView>(`ordering/seller/orders/${sellerOrderId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') return { kind: 'not-found', session };
  if (result.kind !== 'ok') return { kind: 'unavailable' };
  const labels = session.permissionKeys.includes(VIEW_PERMISSION)
    ? await loadLineLabels(result.body)
    : {};
  return { kind: 'ok', session, order: result.body, labels };
}
