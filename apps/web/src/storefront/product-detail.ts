import { formatMoney } from '../format/money.ts';
import type { Money, ProductDetail, ProductOffer } from './types.ts';

// The product page's read of the API (`GET search/product-detail/:productId`, PR #450) and its
// mapping to the page's own shape. What the API does not have yet stays empty and the page hides
// it: photos (catalog media), specifications, certification badges (an anonymous read gets none),
// the regular price beside a special, similar products, the seller's city, "selling since",
// ratings and delivery window.

/** Money as the API sends it: minor units as a decimal string. */
interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

export interface ProductDetailBody {
  readonly productId: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly categoryIds: readonly string[];
  readonly offers: readonly {
    readonly offerId: string;
    readonly sellerId: string;
    readonly seller: {
      readonly storeName: string | null;
      readonly minimumOrder?: MoneyBody | null;
    };
    readonly units: readonly {
      readonly variantId: string;
      readonly label: string | null;
      readonly price: MoneyBody;
      readonly taxInclusive: boolean;
      readonly special: { readonly endsAt: string } | null;
      readonly stock: {
        readonly status: 'in-stock' | 'low' | 'out';
        readonly onlyLeft: number | null;
      };
    }[];
  }[];
}

/** The texts the mapping needs, in the page's language. */
export interface ProductDetailLabels {
  readonly minimum: (amount: string) => string;
  readonly noMinimum: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a path id can name a product of the API (catalog ids are UUIDs). */
export const isProductId = (id: string): boolean => UUID.test(id);

/** API money as the page's; null when the amount is not a safe whole number of minor units. */
function moneyOf(body: MoneyBody): Money | null {
  if (!/^[0-9]{1,15}$/u.test(body.amount)) return null;
  return { amount: Number(body.amount), currency: body.currency };
}

/**
 * The page's product from the API answer, or undefined when no offer can be shown. An offer is
 * shown with its first priced Variant (the page has no Variant picker yet); a seller without a
 * public store name is left out. "Only N left" is the API's `onlyLeft` in the low band; out of
 * stock is a limit of 0, so Add to cart is disabled.
 */
export function productDetailOf(
  body: ProductDetailBody,
  locale: string,
  labels: ProductDetailLabels,
): ProductDetail | undefined {
  const offers = body.offers.flatMap((offer): ProductOffer[] => {
    const unit = offer.units[0];
    const name = offer.seller.storeName;
    const price = unit === undefined ? null : moneyOf(unit.price);
    if (unit === undefined || price === null || name === null) return [];
    const minimum = offer.seller.minimumOrder;
    const minimumMoney = minimum === undefined || minimum === null ? null : moneyOf(minimum);
    return [
      {
        id: offer.offerId,
        variantId: unit.variantId,
        seller: { id: offer.sellerId, name, certificates: [] },
        price,
        certifications: [],
        ...(unit.stock.status === 'out'
          ? { lowStock: 0 }
          : unit.stock.status === 'low' && unit.stock.onlyLeft !== null
            ? { lowStock: unit.stock.onlyLeft }
            : {}),
        ...(minimum === null
          ? { minimumOrder: labels.noMinimum }
          : minimumMoney === null
            ? {}
            : { minimumOrder: labels.minimum(formatMoney(minimumMoney, locale)) }),
      },
    ];
  });
  const [first, ...rest] = offers;
  if (first === undefined) return undefined;
  return {
    id: body.productId,
    name: body.name,
    category: body.categoryIds[0] ?? '',
    description: body.description ?? body.shortDescription ?? '',
    specifications: [],
    photos: [],
    offers: [first, ...rest],
    similar: [],
  };
}
