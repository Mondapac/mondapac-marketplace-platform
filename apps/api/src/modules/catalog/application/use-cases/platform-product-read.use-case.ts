import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type { ProductStatus, VariantState } from '../../domain/product';
import type { StoredRevision } from '../../domain/stored-revision';
import type { OwnCatalogReader, ProductForm } from '../ports/own-catalog.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface PlatformProductReadInput {
  readonly productId: string;
}

export interface PlatformRevisionView {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly submittedAt: string;
  readonly content: Record<string, unknown>;
}

export interface PlatformProductReadOutput {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly familyCode: string;
  /** `single`: one fixed variant, no options; `configurable`: variants defined by option values. */
  readonly variantModel: string;
  readonly status: ProductStatus;
  readonly variants: readonly { variantId: string; state: VariantState }[];
  /** The Market's cap on non-retired variants. */
  readonly maxVariants: number;
  readonly lastChangedAt: string;
  readonly createdAt: string;
  /** What the product form is drawn from: the Market's tax categories, the family's fields and the categories. */
  readonly form: ProductForm & { readonly taxCategoryCodes: readonly string[] };
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  readonly workingCopy: {
    readonly content: Record<string, unknown>;
    readonly lastSavedAt: string;
    readonly baseRevisionId: string | null;
  } | null;
  readonly published: PlatformRevisionView | null;
}

export type PlatformProductReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | ValidationFailure;

export interface PlatformProductReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `platform-product.read` (catalog design 8.2): one PLATFORM product with its working copy and its
 * published revision, for the admin product form. Rule: the key `catalog.platform-product.edit`
 * and the admin population. A SELLER product, a missing one and a discarded one answer one
 * byte-identical `product.not-found`. One read-only unit (ADR-0025); nothing is stored.
 */
export class PlatformProductRead extends UseCase<
  PlatformProductReadInput,
  PlatformProductReadOutput,
  PlatformProductReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-read',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductReadInput,
  ): Promise<Result<PlatformProductReadOutput, PlatformProductReadFailure>> {
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const parsed = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (parsed === null || !parsed.ok) return invalid('productId', 'format');
    const { market } = context;
    const { deps } = this;

    let maxVariants: number;
    let taxCategoryCodes: readonly string[];
    let locales: { default: string; supported: readonly string[] };
    try {
      taxCategoryCodes = deps.policy.taxCategoryCodes(market);
      maxVariants = deps.policy.maxVariantsPerProduct(market);
      const configured = deps.policy.locales(market);
      locales = { default: configured.default, supported: [...configured.supported] };
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
          state.scope !== 'PLATFORM' ||
          state.status === 'discarded'
        ) {
          return ok(null);
        }
        const copy = await deps.workingCopies.find(market, state.id);
        const revisionOf = async (id: Id<'ProductRevision'> | null) =>
          id === null ? null : await deps.revisions.find(market, state.id, id);
        return ok({
          product,
          form: await deps.ownReader.productForm(market, state.familyCode),
          copy,
          published: await revisionOf(state.publishedRevisionId),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    const { product, form, copy, published } = read.value;
    const { state } = product;
    return ok({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      familyCode: state.familyCode,
      variantModel: state.variantModel,
      status: state.status,
      variants: state.variants.map((variant) => ({
        variantId: variant.id,
        state: variant.state,
      })),
      maxVariants,
      lastChangedAt: state.lastChangedAt.toString(),
      createdAt: state.createdAt.toString(),
      form: { ...form, taxCategoryCodes },
      locales,
      workingCopy:
        copy === null
          ? null
          : {
              content: copy.content,
              lastSavedAt: copy.lastSavedAt.toString(),
              baseRevisionId: copy.baseRevisionId,
            },
      published: published === null ? null : viewOf(published),
    });
  }
}

function viewOf(revision: StoredRevision): PlatformRevisionView {
  return {
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    submittedAt: revision.submittedAt.toString(),
    content: revision.content as unknown as Record<string, unknown>,
  };
}
