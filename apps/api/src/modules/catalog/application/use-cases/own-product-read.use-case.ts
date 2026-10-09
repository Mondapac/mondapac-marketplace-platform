import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { ProductStatus, VariantState } from '../../domain/product';
import type { SensitiveReason } from '../../domain/product-revision-policy';
import type { RevisionContent } from '../../domain/revision-content';
import type { StoredRevision } from '../../domain/stored-revision';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { invalid, isoOf, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnProductReadInput {
  readonly productId: string;
}

export interface OwnRevisionView {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly submittedAt: string;
  readonly authorKind: 'seller' | 'admin';
  readonly sensitive: boolean;
  readonly sensitiveReasons: readonly SensitiveReason[];
  readonly content: RevisionContent;
}

export interface OwnProductReadOutput {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly familyCode: string;
  readonly status: ProductStatus;
  readonly variants: readonly { variantId: string; state: VariantState }[];
  /** The Market's cap on non-retired variants. */
  readonly maxVariants: number;
  /** Change reasons the Market sends to review, plus `images` which always is (H1). */
  readonly sensitiveFields: readonly string[];
  readonly lastChangedAt: string;
  readonly createdAt: string;
  readonly pendingSubmittedAt: string | null;
  readonly workingCopy: {
    readonly content: Record<string, unknown>;
    readonly lastSavedAt: string;
    readonly baseRevisionId: string | null;
  } | null;
  readonly published: OwnRevisionView | null;
  readonly pending: OwnRevisionView | null;
}

export type OwnProductReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | ValidationFailure;

export interface OwnProductReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-product.read` (catalog design 8.2, 9.2a): one of the seller's own SELLER products with its
 * working copy, the published revision and the pending one. Rule: the key
 * `catalog.own-product.view` and the seller population. A product of another seller, a PLATFORM
 * product, a missing one and a discarded one answer one byte-identical `product.not-found`. One
 * read-only unit (ADR-0025); nothing is stored.
 */
export class OwnProductRead extends UseCase<
  OwnProductReadInput,
  OwnProductReadOutput,
  OwnProductReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-read',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductReadInput,
  ): Promise<Result<OwnProductReadOutput, OwnProductReadFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const parsed = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (parsed === null || !parsed.ok) return invalid('productId', 'format');
    const { market } = context;
    const { deps } = this;

    let maxVariants: number;
    let sensitiveFields: string[];
    try {
      maxVariants = deps.policy.maxVariantsPerProduct(market);
      sensitiveFields = sensitiveFieldsOf(deps.policy.sensitiveChanges(market));
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const product = await deps.products.findById(market, parsed.value);
        const { state } = product ?? {};
        if (
          product === null ||
          state === undefined ||
          state.scope !== 'SELLER' ||
          state.ownerSellerId !== sellerId ||
          state.status === 'discarded' ||
          state.status === 'withdrawn'
        ) {
          return ok(null);
        }
        const copy = await deps.workingCopies.find(market, state.id);
        const revisionOf = async (id: Id<'ProductRevision'> | null) =>
          id === null ? null : await deps.revisions.find(market, state.id, id);
        return ok({
          product,
          copy,
          published: await revisionOf(state.publishedRevisionId),
          pending: await revisionOf(state.pendingRevisionId),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    const { product, copy, published, pending } = read.value;
    const { state } = product;
    return ok({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      familyCode: state.familyCode,
      status: state.status,
      variants: state.variants.map((variant) => ({
        variantId: variant.id,
        state: variant.state,
      })),
      maxVariants,
      sensitiveFields,
      lastChangedAt: state.lastChangedAt.toString(),
      createdAt: state.createdAt.toString(),
      pendingSubmittedAt: isoOf(state.pendingSubmittedAt),
      workingCopy:
        copy === null
          ? null
          : {
              content: copy.content,
              lastSavedAt: copy.lastSavedAt.toString(),
              baseRevisionId: copy.baseRevisionId,
            },
      published: published === null ? null : viewOf(published),
      pending: pending === null ? null : viewOf(pending),
    });
  }
}

function viewOf(revision: StoredRevision): OwnRevisionView {
  return {
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    submittedAt: revision.submittedAt.toString(),
    authorKind: revision.authorKind,
    sensitive: revision.sensitive,
    sensitiveReasons: revision.sensitiveReasons,
    content: revision.content,
  };
}

/** The field ids the Market sends to review, in a fixed order, plus `images` (always). */
export function sensitiveFieldsOf(
  policy: ReturnType<CatalogMarketPolicy['sensitiveChanges']>,
): string[] {
  const fields: string[] = [];
  if (policy.platformCategories) fields.push('platform-categories');
  if (policy.taxCategory) fields.push('tax-category');
  if (policy.name) fields.push('name');
  if (policy.primaryImage) fields.push('primary-image');
  if (policy.variantRemoved) fields.push('variant-removed');
  fields.push('images');
  return fields;
}
