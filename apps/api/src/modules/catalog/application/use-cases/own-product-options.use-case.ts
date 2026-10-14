import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { OFFER_STATUSES } from '../../domain/offer';
import { PRODUCT_STATUSES } from '../../domain/product';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { sellerOf } from '../own-reads/own-reads.shared';

export interface OwnProductOptionsOutput {
  /**
   * The product types the Market offers that this seller may sell (SEL-12), in the Market's order;
   * empty when `allowedProductTypesOf` fails (fail closed).
   */
  readonly productTypes: readonly string[];
  readonly conditions: readonly string[];
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  /** Whether the Market lets a seller create a product of their own; false on a read fault. */
  readonly sellerCanCreateProduct: boolean;
  /** The statuses a seller sees on products in lists (discarded and withdrawn are not listed). */
  readonly productStatuses: readonly string[];
  /** The statuses a seller sees on Offers in lists (deleted Offers are not listed). */
  readonly offerStatuses: readonly string[];
}

export type OwnProductOptionsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface OwnProductOptionsDependencies {
  readonly policy: CatalogMarketPolicy;
  readonly allowedTypes: AllowedProductTypesReader;
}

const HIDDEN_PRODUCT_STATUSES: ReadonlySet<string> = new Set(['discarded', 'withdrawn']);

/**
 * `own-product.options` (catalog design 8.2): what the seller panel's product form and list
 * filters offer, from the Market configuration: product types, Offer conditions, locales and the
 * statuses a seller sees. Opens no unit of its own. Rule: the key `catalog.own-product.edit`, as
 * the form that uses it. The type list is the Market's narrowed by `allowedProductTypesOf`
 * (SEL-12); create still checks it again.
 */
export class OwnProductOptions extends UseCase<
  Record<string, never>,
  OwnProductOptionsOutput,
  OwnProductOptionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-options',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductOptionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OwnProductOptionsOutput, OwnProductOptionsFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { policy, allowedTypes } = this.deps;
    // The reader answers null on any failure: no type is offered then (fail closed).
    const allowed = await allowedTypes.allowedFor(context, sellerId);
    let canCreate = false;
    try {
      canCreate = await policy.sellerCanCreateProduct(market);
    } catch {
      // ADR-0026 d5: a read fault is the safe value, "off".
    }
    try {
      const locales = policy.locales(market);
      return ok({
        productTypes: policy
          .productTypes(market)
          .filter((type) => allowed === 'all' || (allowed !== null && allowed.has(type))),
        conditions: [...policy.conditions(market)],
        locales: { default: locales.default, supported: [...locales.supported] },
        sellerCanCreateProduct: canCreate,
        productStatuses: PRODUCT_STATUSES.filter((status) => !HIDDEN_PRODUCT_STATUSES.has(status)),
        offerStatuses: OFFER_STATUSES.filter((status) => status !== 'deleted'),
      });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
