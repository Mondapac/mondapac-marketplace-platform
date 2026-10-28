import type { PhotoUrl } from '../storefront/photos.ts';
import type { CartItem, CartSource, IncludedTaxPreview, Money } from '../storefront/types.ts';
import { lineLimit, type Cart } from './cart.ts';

// The buyer's real cart (`GET /cart`) and saved list (`GET /cart/saved`) as the cart screens show
// them. The API answers sell units (an Offer and one of its Variants); the screens key a line by
// one string, so a unit's key is `offerId:variantId` and is parsed back for every write. Every
// field is checked on its own: a line the screens cannot show is set aside as not available, the
// rest of the cart stays. Pure, so the server's first read and the browser's later reads share it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CURRENCY = /^[A-Z]{3}$/u;
const DIGITS = /^[0-9]{1,15}$/u;

/** One sell unit: the Offer and the Variant the cart routes take. */
export interface SellUnit {
  readonly offerId: string;
  readonly variantId: string;
}

/** The cart key of a sell unit. */
export const unitKey = (unit: SellUnit): string => `${unit.offerId}:${unit.variantId}`;

/** The sell unit of a cart key, or null for a key that is not one (a sample product id). */
export function unitOf(key: string): SellUnit | null {
  const [offerId, variantId, rest] = key.split(':');
  return offerId !== undefined &&
    variantId !== undefined &&
    rest === undefined &&
    UUID.test(offerId) &&
    UUID.test(variantId)
    ? { offerId, variantId }
    : null;
}

/**
 * The included-tax preview the live cart shows. A PLACEHOLDER, as in the sample: the cart read
 * gives no tax figure yet, and tax on delivery fees is not settled (tax adviser, 19 Oct 2026).
 */
export const LIVE_TAX_PREVIEW: IncludedTaxPreview = {
  share: { numerator: 1, denominator: 11 },
  includesDelivery: true,
};

/** A cart line the buyer cannot buy now: its name when known, and its line id for Remove. */
export interface UnavailableLine {
  readonly key: string;
  readonly lineId: string;
  /** Null when catalog no longer lists the product. */
  readonly name: string | null;
}

/** The real cart as the store keeps it. */
export interface LiveCart {
  readonly source: CartSource;
  readonly cart: Cart;
  /** The API's line id per cart key, for the quantity and remove routes. */
  readonly lineIds: Readonly<Record<string, string>>;
  readonly unavailable: readonly UnavailableLine[];
}

/** An item of the account's saved list, with the id the saved routes take. */
export interface LiveSavedItem {
  readonly key: string;
  readonly savedId: string;
  /** Null when the item cannot be shown or bought now: the list shows it as unavailable. */
  readonly item: CartItem | null;
}

export const EMPTY_LIVE_CART: LiveCart = {
  source: { items: {}, sellers: {}, tax: LIVE_TAX_PREVIEW, sampleDiscounts: {} },
  cart: {},
  lineIds: {},
  unavailable: [],
};

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const id = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

const text = (value: unknown, max = 300): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;

function moneyOf(value: unknown): Money | null {
  if (!isRecord(value)) return null;
  const { amount, currency } = value;
  if (typeof amount !== 'string' || !DIGITS.test(amount)) return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  const minor = Number(amount);
  return Number.isSafeInteger(minor) ? { amount: minor, currency } : null;
}

/** The units left when stock is low, as the `availability` of a line says. */
function lowStockOf(value: unknown): number | undefined {
  if (!isRecord(value) || value.status !== 'low') return undefined;
  const left = value.onlyLeft;
  return typeof left === 'number' && Number.isSafeInteger(left) && left >= 0 ? left : undefined;
}

interface Display {
  readonly name: string;
  readonly imageUrl?: string;
}

/** A line's name (with its Variant label) and thumbnail, or null when it has none to show. */
function displayOf(value: unknown, photo: PhotoUrl | null): Display | null {
  if (!isRecord(value)) return null;
  const name = text(value.productName);
  if (name === null) return null;
  const label = text(value.variantLabel, 100);
  const productId = id(value.productId);
  const imageId = id(value.imageId);
  const imageUrl =
    photo !== null && productId !== null && imageId !== null
      ? photo(productId, imageId, 'thumb')
      : undefined;
  return {
    name: label === null ? name : `${name}, ${label}`,
    ...(imageUrl === undefined ? {} : { imageUrl }),
  };
}

/** A buyable line's item, or null when any part the screens need is missing. */
function itemOf(
  line: Json,
  sellerId: string,
  sellerName: string | null,
  photo: PhotoUrl | null,
): CartItem | null {
  if (line.state !== 'buyable') return null;
  const price = moneyOf(line.unitPrice);
  const display = displayOf(line.display, photo);
  if (price === null || display === null) return null;
  const lowStock = lowStockOf(line.availability);
  const addedAt = moneyOf(line.previousPrice);
  return {
    name: display.name,
    sellerId,
    ...(sellerName === null ? {} : { sellerName }),
    // No category on a cart line: the thumbnail falls back to the general icon.
    category: '',
    price,
    ...(lowStock === undefined ? {} : { lowStock }),
    ...(display.imageUrl === undefined ? {} : { imageUrl: display.imageUrl }),
    ...(addedAt === null ? {} : { addedAt }),
  };
}

/**
 * The cart of a `GET /cart` body. A seller group is shown with its store name, its minimum order
 * (only when the API says the minimum applies) and its flat delivery fee; a group without a fee
 * cannot be checked out, so its lines are set aside as not available, as are lines that are not
 * buyable or have no name. Null for a body that is not a cart.
 */
export function liveCartOf(body: unknown, photo: PhotoUrl | null): LiveCart | null {
  if (!isRecord(body) || !Array.isArray(body.groups)) return null;
  const items: Record<string, CartItem> = {};
  const sellers: Record<string, CartSource['sellers'][string]> = {};
  const cart: Record<string, Cart[string]> = {};
  const lineIds: Record<string, string> = {};
  const unavailable: UnavailableLine[] = [];
  for (const group of body.groups) {
    if (!isRecord(group) || !Array.isArray(group.lines)) continue;
    const sellerId = id(group.sellerId);
    const fee = moneyOf(group.deliveryFee);
    const minimumOrder =
      isRecord(group.minimumOrder) &&
      (group.minimumOrder.state === 'met' || group.minimumOrder.state === 'below-minimum')
        ? moneyOf(group.minimumOrder.minimum)
        : null;
    for (const line of group.lines) {
      if (!isRecord(line)) continue;
      const offerId = id(line.offerId);
      const variantId = id(line.variantId);
      const lineId = id(line.lineId);
      const quantity = line.quantity;
      if (offerId === null || variantId === null || lineId === null) continue;
      if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) continue;
      const key = unitKey({ offerId, variantId });
      lineIds[key] = lineId;
      const item =
        sellerId === null || fee === null
          ? null
          : itemOf(line, sellerId, text(group.sellerName), photo);
      if (item === null || sellerId === null || fee === null) {
        unavailable.push({ key, lineId, name: displayOf(line.display, null)?.name ?? null });
        continue;
      }
      items[key] = item;
      sellers[sellerId] ??= {
        id: sellerId,
        name: text(group.sellerName) ?? '',
        // No delivery promise in the backend yet: the window is left out where it would show.
        deliveryWindow: '',
        deliveryFee: fee,
        ...(minimumOrder === null ? {} : { minimumOrder }),
      };
      cart[key] = { quantity, unitPrice: item.price, limit: lineLimit(item.lowStock) };
    }
  }
  return {
    source: { items, sellers, tax: LIVE_TAX_PREVIEW, sampleDiscounts: {} },
    cart,
    lineIds,
    unavailable,
  };
}

/** The account's saved list of a `GET /cart/saved` body, newest first; null when it is not one. */
export function liveSavedOf(body: unknown, photo: PhotoUrl | null): LiveSavedItem[] | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  return body.items.flatMap((entry): LiveSavedItem[] => {
    if (!isRecord(entry)) return [];
    const savedId = id(entry.savedId);
    const offerId = id(entry.offerId);
    const variantId = id(entry.variantId);
    if (savedId === null || offerId === null || variantId === null) return [];
    const sellerId = id(entry.sellerId);
    const sellerName = text(entry.sellerName);
    return [
      {
        key: unitKey({ offerId, variantId }),
        savedId,
        item: sellerId === null ? null : itemOf(entry, sellerId, sellerName, photo),
      },
    ];
  });
}
