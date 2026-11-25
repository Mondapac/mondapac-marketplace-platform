import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  heldKeys,
  rowActions,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import type { Offer, OfferHandling, OfferStatus } from '../../domain/offer';
import type { OfferPendingChange } from '../../domain/offer-pending-change';
import { offerChangeViewOf, type OfferChangeView } from '../offer-change-view';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';

/** The decisions of a held change; each needs the approve key (the use case checks it again). */
export const OFFER_CHANGE_ROW_ACTION_RULES: readonly RowActionRule<unknown>[] = [
  { id: 'approve', permission: CATALOG_PRODUCT_APPROVE.key },
  { id: 'request-changes', permission: CATALOG_PRODUCT_APPROVE.key },
  { id: 'reject', permission: CATALOG_PRODUCT_APPROVE.key },
];

/** The live Offer's values next to the proposed ones (the reviewer's Live | Proposed diff). */
export interface OfferChangeLiveValues {
  readonly description: Readonly<Record<string, string>>;
  readonly handling: OfferHandling | null;
  /** The distinct type codes of the Offer's open (not removed) tags, sorted. */
  readonly tagTypes: readonly string[];
}

/** One held change as the admin queue shows it (slice 5). */
export interface AdminOfferChangeRow extends OfferChangeView {
  readonly sellerId: string;
  /** The seller's public store name; null when `sellers` cannot say. */
  readonly storeName: string | null;
  /** The Offer as it is now; null only if it cannot be read (never for a pending change). */
  readonly offer: {
    readonly productId: string;
    readonly sellerSku: string;
    readonly conditionCode: string;
    readonly status: OfferStatus;
    /** The Offer's current version (the change raised it when it was held). */
    readonly version: number;
  } | null;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    /** The published name in the Market's default locale. */
    readonly name: string | null;
  };
  readonly live: OfferChangeLiveValues | null;
  /** The decisions the caller may take: `approve`, `request-changes`, `reject`. */
  readonly actions: readonly string[];
}

export interface AdminOfferChangeRowsDependencies {
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly sellerNames: SellerNamesReader;
  readonly productApproveProbe: PermissionProbe;
}

/** What the unit reads for a page of changes: the live Offers and their product labels. */
export interface AdminOfferChangeFacts {
  readonly offers: ReadonlyMap<string, Offer>;
  readonly labels: ReadonlyMap<
    string,
    { productCode: string; typeCode: string; name: string | null }
  >;
}

/** Inside the caller's read-only unit: the live Offers (with open tags) and product labels. */
export async function readAdminOfferChangeFacts(
  deps: Pick<AdminOfferChangeRowsDependencies, 'offers' | 'ownReader'>,
  market: MarketContext,
  changes: readonly OfferPendingChange[],
  locale: string,
): Promise<AdminOfferChangeFacts> {
  const offerIds = [...new Set(changes.map((change) => change.state.offerId))];
  const offers = offerIds.length === 0 ? [] : await deps.offers.findManyByIds(market, offerIds);
  const productIds = [...new Set(offers.map((offer) => offer.state.productId))];
  const labels =
    productIds.length === 0 ? [] : await deps.ownReader.productLabels(market, productIds, locale);
  return {
    offers: new Map(offers.map((offer) => [offer.state.id, offer])),
    labels: new Map(
      labels.map((label) => [
        label.productId,
        { productCode: label.productCode, typeCode: label.typeCode, name: label.name },
      ]),
    ),
  };
}

/** The live values of an Offer: description, handling and the type codes of its open tags. */
export function liveValuesOf(offer: Offer): OfferChangeLiveValues {
  const types = new Set(
    offer.tags.filter((tag) => tag.status !== 'removed').map((tag) => tag.typeCode),
  );
  return {
    description: offer.state.description,
    handling: offer.state.handling,
    tagTypes: [...types].sort(),
  };
}

/** After the unit: the store names and the caller's actions, then one row per change. */
export async function adminOfferChangeRows(
  deps: Pick<AdminOfferChangeRowsDependencies, 'sellerNames' | 'productApproveProbe'>,
  context: CallContext,
  changes: readonly OfferPendingChange[],
  facts: AdminOfferChangeFacts,
): Promise<AdminOfferChangeRow[]> {
  const names =
    changes.length === 0
      ? new Map<string, string>()
      : await deps.sellerNames.storeNames(context, [
          ...new Set(changes.map((change) => change.state.sellerId)),
        ] as Id<'Seller'>[]);
  const granted = await heldKeys(context, {
    [CATALOG_PRODUCT_APPROVE.key]: deps.productApproveProbe,
  });
  const actions = rowActions({}, OFFER_CHANGE_ROW_ACTION_RULES, granted);
  return changes.map((change) => {
    const offer = facts.offers.get(change.state.offerId) ?? null;
    const label = offer === null ? undefined : facts.labels.get(offer.state.productId);
    return {
      ...offerChangeViewOf(change),
      sellerId: change.state.sellerId,
      storeName: names.get(change.state.sellerId) ?? null,
      offer:
        offer === null
          ? null
          : {
              productId: offer.state.productId,
              sellerSku: offer.state.sellerSku,
              conditionCode: offer.state.conditionCode,
              status: offer.state.status,
              version: offer.state.version,
            },
      product: {
        productCode: label?.productCode ?? null,
        typeCode: label?.typeCode ?? null,
        name: label?.name ?? null,
      },
      live: offer === null ? null : liveValuesOf(offer),
      actions,
    };
  });
}
