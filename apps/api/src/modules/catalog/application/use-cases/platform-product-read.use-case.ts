import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type { ProductStatus, VariantState } from '../../domain/product';
import type { StoredRevision } from '../../domain/stored-revision';
import { MAX_TOPICS_PER_PRODUCT } from '../../domain/topic';
import type { TopicReader } from '../ports/topic.reader';
import { draftTopicIds, topicRefsOf, type TopicRef } from '../topics/topic-refs';
import type { OwnCatalogReader, ProductForm } from '../ports/own-catalog.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { invalid, isoOf, type ValidationFailure } from '../own-reads/own-reads.shared';

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
  /** When an admin paused the product (offers off sale); null when it is not paused. */
  readonly pausedAt: string | null;
  /** The Offers on it (not deleted), every seller; read only, for "Sellers selling it". */
  readonly offers: { readonly sellerCount: number; readonly offerCount: number };
  readonly variants: readonly { variantId: string; state: VariantState }[];
  /** The Market's cap on non-retired variants. */
  readonly maxVariants: number;
  /** The Market's cap on the options a product varies on (1 or 2); Add a second type needs 2. */
  readonly maxAxes: number;
  /** The product version, for the commands that name it (Add sizes). */
  readonly version: number;
  /** A revision waits for review. */
  readonly pendingSubmittedAt: string | null;
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
  /** The topics named by the draft and the published revision (`topicIds`), each once. */
  readonly topicRefs: readonly TopicRef[];
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
  /** The topics, to name the ids of the draft and the published revision. */
  readonly topicReader?: Pick<TopicReader, 'briefsOf'>;
  /** The feature set follows the draft's primary category (A4 CAT-10); absent: the stored one. */
  readonly familyResolver?: ProductFamilyResolver;
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
    let maxAxes: number;
    let taxCategoryCodes: readonly string[];
    let locales: { default: string; supported: readonly string[] };
    try {
      taxCategoryCodes = deps.policy.taxCategoryCodes(market);
      maxVariants = deps.policy.maxVariantsPerProduct(market);
      maxAxes = deps.policy.maxVariantAttributes(market);
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
        // The form shows the feature set the draft's primary category holds now; nothing is stored.
        // When it cannot be resolved the stored one is shown (the submit fails closed on its own).
        const rawCategories = copy?.content['categoryIds'];
        const primaryCategoryId =
          Array.isArray(rawCategories) && typeof rawCategories[0] === 'string'
            ? rawCategories[0]
            : null;
        const resolved =
          deps.familyResolver === undefined || copy === null
            ? null
            : await deps.familyResolver.resolve(market, primaryCategoryId);
        const shownFamily =
          resolved !== null && resolved.ok ? resolved.familyCode : state.familyCode;
        const published = await revisionOf(state.publishedRevisionId);
        const topicRefs = await topicRefsOf(
          deps.topicReader,
          market,
          // The published ids first, so an oversized draft cannot crowd their names out.
          [
            ...(published?.content.topicIds ?? []),
            ...draftTopicIds(copy?.content).slice(0, MAX_TOPICS_PER_PRODUCT),
          ],
          locales.default,
        );
        return ok({
          product,
          shownFamily,
          form: await deps.ownReader.productForm(market, shownFamily),
          copy,
          published,
          topicRefs: [...topicRefs.values()],
          offers: await deps.ownReader.offerTotalsOfProduct(market, state.id),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    const { product, shownFamily, form, copy, published, offers, topicRefs } = read.value;
    const { state } = product;
    return ok({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      familyCode: shownFamily,
      variantModel: state.variantModel,
      status: state.status,
      pausedAt: isoOf(state.pausedAt),
      offers,
      variants: state.variants.map((variant) => ({
        variantId: variant.id,
        state: variant.state,
      })),
      maxVariants,
      maxAxes,
      version: state.version,
      pendingSubmittedAt: isoOf(state.pendingSubmittedAt),
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
      topicRefs,
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
