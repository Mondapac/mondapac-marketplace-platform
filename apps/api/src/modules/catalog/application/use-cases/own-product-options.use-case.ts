import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { OFFER_STATUSES } from '../../domain/offer';
import { PRODUCT_STATUSES } from '../../domain/product';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { OwnCatalogReader, ProductFormCategory } from '../ports/own-catalog.reader';
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
  /** The Market's tax category codes, as the product read's `form` lists them. */
  readonly taxCategoryCodes: readonly string[];
  /** The platform categories a product may be filed under, as the product read's `form` lists them; empty when the read failed. */
  readonly categories: readonly ProductFormCategory[];
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
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
}

const HIDDEN_PRODUCT_STATUSES: ReadonlySet<string> = new Set(['discarded', 'withdrawn']);

/**
 * `own-product.options` (catalog design 8.2): what the seller panel's product form and list
 * filters offer, from the Market configuration: product types, Offer conditions, locales and the
 * statuses a seller sees. Reads the category list in one read-only unit (no transaction, ADR-0025); a failed read answers an empty list. Rule: the key `catalog.own-product.edit`, as
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

  readonly #logger = new Logger('OwnProductOptions');

  #warnCategories(context: CallContext): void {
    this.#logger.warn({
      message: 'own-product.options: the category list could not be read; answering an empty list',
      correlationId: context.correlationId,
    });
  }

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
    // The category list does not depend on a product: the Add page needs it before one exists.
    // Other pages read these options and do not need the list: a failed read answers an empty
    // list (the Add page says so) instead of failing the whole read.
    let categories: readonly ProductFormCategory[] = [];
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => ok(await this.deps.ownReader.productCategories(market)),
        { readOnly: true },
      );
      if (read.ok) categories = read.value;
      else this.#warnCategories(context);
    } catch {
      this.#warnCategories(context);
    }
    try {
      const locales = policy.locales(market);
      return ok({
        productTypes: policy
          .productTypes(market)
          .filter((type) => allowed === 'all' || (allowed !== null && allowed.has(type))),
        conditions: [...policy.conditions(market)],
        locales: { default: locales.default, supported: [...locales.supported] },
        taxCategoryCodes: [...policy.taxCategoryCodes(market)],
        categories,
        sellerCanCreateProduct: canCreate,
        productStatuses: PRODUCT_STATUSES.filter((status) => !HIDDEN_PRODUCT_STATUSES.has(status)),
        offerStatuses: OFFER_STATUSES.filter((status) => status !== 'deleted'),
      });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
