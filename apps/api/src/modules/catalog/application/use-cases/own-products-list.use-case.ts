import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { ProductStatus } from '../../domain/product';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { isoOf, parsePage, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnProductsListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface OwnProductListItem {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: ProductStatus;
  /** The draft name in the Market's default locale, else null. */
  readonly draftName: string | null;
  readonly hasPublishedRevision: boolean;
  readonly hasPendingRevision: boolean;
  readonly pendingSubmittedAt: string | null;
  readonly lastChangedAt: string;
  readonly createdAt: string;
}

export interface OwnProductsListOutput {
  readonly items: readonly OwnProductListItem[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export type OwnProductsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnProductsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-products.list` (catalog design 8.2, 9.2a): the seller's own SELLER products, newest first,
 * keyset-paged. Rule: the key `catalog.own-product.view` and the seller population; the seller
 * comes from the actor and the repository takes it from there, so another seller's product is
 * never read. Runs in one read-only unit (ADR-0025).
 */
export class OwnProductsList extends UseCase<
  OwnProductsListInput,
  OwnProductsListOutput,
  OwnProductsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-products-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductsListInput,
  ): Promise<Result<OwnProductsListOutput, OwnProductsListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const page = parsePage<'Product'>(input);
    if (!page.ok) return page;
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        // One extra row tells whether another page follows.
        const rows = await this.deps.ownReader.listProducts(market, sellerId, {
          afterId: page.value.afterId,
          limit: page.value.limit + 1,
        });
        const shown = rows.slice(0, page.value.limit);
        const copies = await this.deps.ownReader.findWorkingCopies(
          market,
          shown.map((product) => product.state.id),
        );
        return ok({ rows, shown, copies });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { rows, shown, copies } = read.value;
    const nameOf = new Map(
      copies.map((copy) => [copy.productId, draftNameOf(copy.content, locale)]),
    );
    const items = shown.map(({ state }): OwnProductListItem => ({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      status: state.status,
      draftName: nameOf.get(state.id) ?? null,
      hasPublishedRevision: state.publishedRevisionId !== null,
      hasPendingRevision: state.pendingRevisionId !== null,
      pendingSubmittedAt: isoOf(state.pendingSubmittedAt),
      lastChangedAt: state.lastChangedAt.toString(),
      createdAt: state.createdAt.toString(),
    }));
    return ok({
      items,
      nextAfterId: rows.length > shown.length ? (shown[shown.length - 1]?.state.id ?? null) : null,
    });
  }
}

/** The draft's name in a locale, read defensively: a draft is only shape-checked at save. */
export function draftNameOf(content: Record<string, unknown>, locale: string): string | null {
  const texts = content['texts'];
  if (typeof texts !== 'object' || texts === null) return null;
  const entry = (texts as Record<string, unknown>)[locale];
  if (typeof entry !== 'object' || entry === null) return null;
  const name = (entry as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}
