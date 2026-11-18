import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { OWN_PRODUCT_SORTS } from '../use-cases/own-products-list.use-case';
import { parseListQuery, type OwnProductView } from '../use-cases/own-products-list.use-case';
import type { OwnOfferSort } from '../ports/own-catalog.reader';
import { parseOfferListQuery, type OwnOfferViewTab } from '../use-cases/own-offers-list.use-case';

// The seller lists that can keep saved filters (catalog design 9.2d). A list is named by a dotted
// key that starts with `seller.` (the table's CHECK ties that prefix to a store). Its entry says
// which permission shows the list and how to read the document it saves. Adding a seller list is
// one entry here (and its key in the audit vocabulary).

/**
 * The saved document of the seller Products list: the selector of `GET catalog/seller/products`
 * (tab, search, filters, sort), without the page. Flat, with the list's own keys, so a client can
 * spread it into the list query. Only the keys that are set appear, except the tab, sort and
 * direction, which are always stored resolved.
 */
export interface OwnProductsFilterPayload {
  readonly v: 1;
  readonly view: OwnProductView;
  readonly q?: string;
  readonly status?: string;
  readonly categoryId?: string;
  readonly paused?: boolean;
  readonly typeCode?: string;
  readonly sort: (typeof OWN_PRODUCT_SORTS)[number];
  readonly direction: 'asc' | 'desc';
}

/**
 * The saved document of the seller Offers list: the selector of `GET catalog/seller/offers`
 * (tab, search, status, listing, sort), without the page. Flat, like the Products document; only
 * the keys that are set appear, except the tab, sort and direction (always stored resolved).
 */
export interface OwnOffersFilterPayload {
  readonly v: 1;
  readonly view: OwnOfferViewTab;
  readonly q?: string;
  readonly status?: string;
  readonly listed?: boolean;
  readonly sort: OwnOfferSort;
  readonly direction: 'asc' | 'desc';
}

export type SellerSavedFilterPayload = OwnProductsFilterPayload | OwnOffersFilterPayload;

export interface SellerSavedFilterListDefinition {
  readonly key: string;
  /** The permission that lets a member see the list, hence its saved views. */
  readonly viewKey: string;
  /** The closed document of a request or a stored row, in its canonical form. */
  parsePayload(raw: unknown): Result<SellerSavedFilterPayload, ValidationFailure>;
}

const SELECTOR_KEYS = [
  'view',
  'q',
  'status',
  'categoryId',
  'paused',
  'typeCode',
  'sort',
  'direction',
] as const;
const PAYLOAD_KEYS = new Set<string>(['v', ...SELECTOR_KEYS]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOwnProductsPayload(
  raw: unknown,
): Result<OwnProductsFilterPayload, ValidationFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw))
    if (!PAYLOAD_KEYS.has(key)) return invalid(`payload.${key}`, 'unknown');
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  // The list's own closed parser reads the selector, so a saved value is exactly one the list would
  // accept; the page keys never reach it (they are unknown to this document, refused above).
  const selector: Record<string, unknown> = {};
  for (const key of SELECTOR_KEYS) if (raw[key] !== undefined) selector[key] = raw[key];
  const parsed = parseListQuery(selector);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: 'validation.failed',
        fields: parsed.error.fields.map((field) => ({
          path: `payload.${field.path}`,
          code: field.code,
        })),
      },
    };
  }
  const q = parsed.value;
  return ok({
    v: 1,
    view: q.view,
    ...(q.text === null ? {} : { q: q.text }),
    ...(q.status === null ? {} : { status: q.status }),
    ...(q.categoryId === null ? {} : { categoryId: q.categoryId }),
    ...(q.paused === null ? {} : { paused: q.paused }),
    ...(q.typeCode === null ? {} : { typeCode: q.typeCode }),
    sort: q.sort,
    direction: q.direction,
  });
}

const OFFER_SELECTOR_KEYS = ['view', 'q', 'status', 'listed', 'sort', 'direction'] as const;
const OFFER_PAYLOAD_KEYS = new Set<string>(['v', ...OFFER_SELECTOR_KEYS]);

function parseOwnOffersPayload(raw: unknown): Result<OwnOffersFilterPayload, ValidationFailure> {
  if (!isRecord(raw)) return invalid('payload', 'type');
  for (const key of Object.keys(raw))
    if (!OFFER_PAYLOAD_KEYS.has(key)) return invalid(`payload.${key}`, 'unknown');
  if (raw['v'] !== 1) return invalid('payload.v', 'value');
  // The Offer list's own closed parser reads the selector; the page keys are refused above.
  const selector: Record<string, unknown> = {};
  for (const key of OFFER_SELECTOR_KEYS) if (raw[key] !== undefined) selector[key] = raw[key];
  const parsed = parseOfferListQuery(selector);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: 'validation.failed',
        fields: parsed.error.fields.map((field) => ({
          path: `payload.${field.path}`,
          code: field.code,
        })),
      },
    };
  }
  const q = parsed.value;
  return ok({
    v: 1,
    view: q.view,
    ...(q.text === null ? {} : { q: q.text }),
    ...(q.status === null ? {} : { status: q.status }),
    ...(q.listed === null ? {} : { listed: q.listed }),
    sort: q.sort,
    direction: q.direction,
  });
}

const OWN_PRODUCTS_LIST: SellerSavedFilterListDefinition = {
  key: 'seller.catalog.products',
  viewKey: CATALOG_OWN_PRODUCT_VIEW.key,
  parsePayload: parseOwnProductsPayload,
};

const OWN_OFFERS_LIST: SellerSavedFilterListDefinition = {
  key: 'seller.catalog.offers',
  viewKey: CATALOG_OWN_PRODUCT_VIEW.key,
  parsePayload: parseOwnOffersPayload,
};

export const SELLER_SAVED_FILTER_LISTS: Readonly<Record<string, SellerSavedFilterListDefinition>> =
  Object.freeze({
    [OWN_PRODUCTS_LIST.key]: OWN_PRODUCTS_LIST,
    [OWN_OFFERS_LIST.key]: OWN_OFFERS_LIST,
  });

export const SELLER_SAVED_FILTER_LIST_KEYS: readonly string[] =
  Object.keys(SELLER_SAVED_FILTER_LISTS);

/** The seller list a request names, or null for a key that is no seller list. */
export const sellerSavedFilterListOf = (value: unknown): SellerSavedFilterListDefinition | null =>
  typeof value === 'string' && Object.hasOwn(SELLER_SAVED_FILTER_LISTS, value)
    ? (SELLER_SAVED_FILTER_LISTS[value] ?? null)
    : null;
