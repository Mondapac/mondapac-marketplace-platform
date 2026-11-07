import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { ProductStatus, VariantState } from '../../domain/product';
import type { SensitiveReason } from '../../domain/product-revision-policy';
import type { RevisionContent } from '../../domain/revision-content';
import type { StoredRevision } from '../../domain/stored-revision';
import { MAX_TOPICS_PER_PRODUCT } from '../../domain/topic';
import type { OwnCatalogReader, ProductForm } from '../ports/own-catalog.reader';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { TopicReader } from '../ports/topic.reader';
import { draftTopicIds, topicRefsOf, type TopicRef } from '../topics/topic-refs';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
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
  /** `single`: one fixed variant, no options; `configurable`: variants defined by option values. */
  readonly variantModel: string;
  readonly status: ProductStatus;
  /** The seller marked the product as carrying their own brand (it lets them propose a brand). */
  readonly ownBrand: boolean;
  readonly variants: readonly { variantId: string; state: VariantState }[];
  /** The Market's cap on non-retired variants. */
  readonly maxVariants: number;
  /** Change reasons the Market sends to review, plus `images` which always is (H1). */
  readonly sensitiveFields: readonly string[];
  readonly lastChangedAt: string;
  readonly createdAt: string;
  readonly pendingSubmittedAt: string | null;
  /** What the product form is drawn from: the Market's tax categories, the family's fields and the categories. */
  readonly form: ProductForm & {
    readonly taxCategoryCodes: readonly string[];
    /** The Market's units with their labels per locale; a measure field names its units by code. */
    readonly units: ReturnType<CatalogMarketPolicy['units']>;
  };
  readonly workingCopy: {
    readonly content: Record<string, unknown>;
    readonly lastSavedAt: string;
    readonly baseRevisionId: string | null;
  } | null;
  readonly published: OwnRevisionView | null;
  readonly pending: OwnRevisionView | null;
  /**
   * The reviewer's request for changes on the newest revision, with the reason code of the
   * Market list; null when the newest revision was not sent back (a newer submit clears it).
   */
  readonly changeRequest: {
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly reasonCode: string;
    readonly decidedAt: string;
  } | null;
  /**
   * The seller's value suggestions for this product, newest first (attributes A5). An open one
   * means the field stays empty until an admin decides; a decided one shows what became of it.
   * Empty when the suggestion store is not wired.
   */
  readonly suggestions: readonly OwnSuggestionView[];
  /**
   * The topics named by the draft, the published and the pending revision (product tags T2), each
   * once with its slug, state and name; look a `topicIds` entry up here. A topic that no longer
   * exists in the Market is absent.
   */
  readonly topicRefs: readonly TopicRef[];
}

export interface OwnSuggestionView {
  readonly id: string;
  readonly attributeCode: string;
  /** The seller's own text, back to them. */
  readonly label: string;
  readonly status: 'open' | 'approved' | 'mapped' | 'rejected';
  /** The value added or chosen (approved, mapped). */
  readonly optionCode: string | null;
  /** The reviewer's words (rejected). */
  readonly rejectReason: string | null;
  readonly createdAt: string;
}

/** The most suggestions one product read lists. */
export const OWN_SUGGESTIONS_MAX = 20;

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
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly suggestions?: AttributeValueSuggestionStore;
  readonly attributeStore?: AttributeDefinitionStore;
  /** The topics, to name the ids of the draft and of the revisions. */
  readonly topicReader?: Pick<TopicReader, 'briefsOf'>;
  /** Shows the feature set of the draft's current primary category (CAT-10); display only. */
  readonly familyResolver?: ProductFamilyResolver;
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
    let taxCategoryCodes: readonly string[];
    let units: ReturnType<CatalogMarketPolicy['units']>;
    try {
      taxCategoryCodes = deps.policy.taxCategoryCodes(market);
      units = deps.policy.units(market);
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
        const suggestions: OwnSuggestionView[] = [];
        if (deps.suggestions !== undefined && deps.attributeStore !== undefined) {
          const codes = new Map<string, string | null>();
          for (const suggestion of await deps.suggestions.listOfProduct(
            market,
            state.id,
            OWN_SUGGESTIONS_MAX,
          )) {
            const row = suggestion.state;
            if (!codes.has(row.definitionId)) {
              const definition = await deps.attributeStore.findById(market, row.definitionId);
              codes.set(row.definitionId, definition === null ? null : definition.state.code);
            }
            const attributeCode = codes.get(row.definitionId);
            if (attributeCode === null || attributeCode === undefined) continue;
            suggestions.push({
              id: row.id,
              attributeCode,
              label: row.label,
              status: row.status,
              optionCode: row.optionCode,
              rejectReason: row.rejectReason,
              createdAt: row.createdAt.toString(),
            });
          }
        }
        const publishedRevision = await revisionOf(state.publishedRevisionId);
        const pendingRevision = await revisionOf(state.pendingRevisionId);
        const topicRefs = await topicRefsOf(
          deps.topicReader,
          market,
          // Published and pending first, so an oversized draft cannot crowd their names out.
          [
            ...(publishedRevision?.content.topicIds ?? []),
            ...(pendingRevision?.content.topicIds ?? []),
            ...draftTopicIds(copy?.content).slice(0, MAX_TOPICS_PER_PRODUCT),
          ],
          deps.policy.locales(market).default,
        );
        return ok({
          product,
          suggestions,
          topicRefs: [...topicRefs.values()],
          form: await deps.ownReader.productForm(market, shownFamily),
          copy,
          shownFamily,
          published: publishedRevision,
          pending: pendingRevision,
          changeRequest: await deps.revisions.latestChangeRequest(market, state.id),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'product.not-found' });
    const {
      product,
      form,
      copy,
      shownFamily,
      published,
      pending,
      changeRequest,
      suggestions,
      topicRefs,
    } = read.value;
    const { state } = product;
    return ok({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      familyCode: shownFamily,
      variantModel: state.variantModel,
      status: state.status,
      ownBrand: state.ownBrand,
      variants: state.variants.map((variant) => ({
        variantId: variant.id,
        state: variant.state,
      })),
      maxVariants,
      sensitiveFields,
      lastChangedAt: state.lastChangedAt.toString(),
      createdAt: state.createdAt.toString(),
      pendingSubmittedAt: isoOf(state.pendingSubmittedAt),
      form: { ...form, taxCategoryCodes, units },
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
      changeRequest:
        changeRequest === null
          ? null
          : {
              revisionId: changeRequest.revisionId,
              revisionNo: changeRequest.revisionNo,
              reasonCode: changeRequest.reasonCode,
              decidedAt: changeRequest.decidedAt.toString(),
            },
      suggestions,
      topicRefs,
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
  if (policy.gtinChanged) fields.push('gtin-changed');
  // A change of the topic set is always reviewed (tags decision 3). `topics` joins this list in
  // PR 4, together with the seller panel's message for it; listing it before that would show a
  // raw message key in the seller's edit form.
  fields.push('images');
  return fields;
}
