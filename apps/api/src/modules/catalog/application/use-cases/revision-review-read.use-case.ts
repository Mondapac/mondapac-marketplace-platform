import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { ProductState, ProductStatus } from '../../domain/product';
import type { RevisionKind, StoredRevision } from '../../domain/stored-revision';
import { parseAdminImageIds } from '../images/admin-image-input';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { TopicReader } from '../ports/topic.reader';
import { topicRefsOf, type TopicRef } from '../topics/topic-refs';
import type { ProductRepository } from '../ports/product.repository';
import type {
  ProductRevisionRepository,
  RevisionHistoryEntry,
} from '../ports/product-revision.repository';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import type { GtinDuplicate, VariantGtinRegistry } from '../ports/variant-gtin.registry';
import type { ValidationFailure } from '../own-reads/own-reads.shared';
import { requiredChecksOf, type ReviewCheckCode } from '../revisions/review-checks';

export interface ProductRevisionAdminReadInput {
  readonly productId: string;
  readonly revisionId: string;
}

/** One variant of a revision as the reviewer compares it. */
export interface AdminRevisionVariantView {
  readonly variantId: string;
  readonly position: number;
  readonly optionValues: Readonly<Record<string, string>>;
  /** Locale to label. */
  readonly labels: Readonly<Record<string, string>>;
  readonly gtin: string | null;
  readonly shippingWeightGrams: number | null;
  readonly shippingLengthMm: number | null;
  readonly shippingWidthMm: number | null;
  readonly shippingHeightMm: number | null;
  readonly imageIds: readonly string[];
}

/**
 * The frozen content of one revision as the reviewer compares it (design board 2): texts per
 * locale, platform categories in order, the tax category, attribute values, variants and photo
 * ids in order (the photos themselves come from `.../revisions/:r/images`).
 */
export interface AdminRevisionContentView {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  readonly authorKind: 'seller' | 'admin';
  readonly submittedAt: string;
  readonly texts: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly shortDescription: string | null;
        readonly description: string | null;
      }
    >
  >;
  readonly categoryIds: readonly string[];
  /** Topic ids in the order entered; named in `topicRefs` of the output (product tags T2). */
  readonly topicIds: readonly string[];
  readonly taxCategoryCode: string;
  readonly attributeValues: Readonly<Record<string, unknown>>;
  readonly variants: readonly AdminRevisionVariantView[];
  readonly imageIds: readonly string[];
}

/** One entry of the product's review history, newest first. Codes and instants only. */
export interface AdminRevisionHistoryView {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  readonly authorKind: 'seller' | 'admin';
  readonly submittedAt: string;
  readonly decision: {
    readonly outcome: 'published' | 'changes-requested' | 'superseded';
    readonly publishKind: string | null;
    readonly supersededCause: string | null;
    readonly reasonCode: string | null;
    readonly decidedByKind: 'admin' | 'seller' | 'system';
    readonly decidedAt: string;
  } | null;
}

export interface ProductRevisionAdminReadOutput {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly status: ProductStatus;
  /** The product version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  /** The seller's public store name; null when `sellers` cannot say. */
  readonly storeName: string | null;
  /** `pending` waits for a decision; `published` is the live one; `closed` was decided or replaced. */
  readonly state: 'pending' | 'published' | 'closed';
  /** True while the product has never been published. */
  readonly firstPublication: boolean;
  /** What changed, as classification codes (design 4.3). */
  readonly reasons: readonly string[];
  /** The checks an approval must confirm; empty unless the revision is pending (design 8.3a). */
  readonly requiredChecks: readonly ReviewCheckCode[];
  /** The duplicate-GTIN advice of the queue row (V4); empty unless pending. */
  readonly warnings: readonly string[];
  readonly revision: AdminRevisionContentView;
  /** The topics of both contents, each once, with slug, state and name; empty if unreadable. */
  readonly topicRefs: readonly TopicRef[];
  /**
   * What the revision changes in the topic set against the published one (all added before the
   * first publication). Order is not a change. Ids; look them up in `topicRefs`.
   */
  readonly topicDiff: { readonly added: readonly string[]; readonly removed: readonly string[] };
  /** The published revision's content; null when the product was never published. */
  readonly published: AdminRevisionContentView | null;
  /** The product's revisions with their decisions, newest first, at most {@link HISTORY_LIMIT}. */
  readonly history: readonly AdminRevisionHistoryView[];
}

export type ProductRevisionAdminReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'revision.not-found' }
  | ValidationFailure;

export interface ProductRevisionAdminReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly revisions: ProductRevisionRepository;
  readonly sellerNames: SellerNamesReader;
  readonly gtinRegistry: VariantGtinRegistry;
  /** The topics, to name the ids of the two contents; without it the names are left out. */
  readonly topicReader?: Pick<TopicReader, 'briefsOf'>;
  /** The Market's default locale names a topic. Without it the names are left out. */
  readonly policy?: Pick<CatalogMarketPolicy, 'locales'>;
}

type Loaded =
  | { readonly found: 'product' }
  | { readonly found: 'revision' }
  | {
      readonly found: 'both';
      readonly state: ProductState;
      readonly sellerId: Id<'Seller'>;
      readonly revision: StoredRevision;
      readonly published: StoredRevision | null;
      readonly history: readonly RevisionHistoryEntry[];
      readonly pending: boolean;
      readonly duplicates: readonly GtinDuplicate[];
    };

/** The most history entries one read returns. */
export const HISTORY_LIMIT = 50;

function contentView(revision: StoredRevision): AdminRevisionContentView {
  const { content } = revision;
  return {
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    kind: revision.kind,
    authorKind: revision.authorKind,
    submittedAt: revision.submittedAt.toString(),
    texts: content.texts,
    categoryIds: content.categoryIds,
    topicIds: content.topicIds,
    taxCategoryCode: content.taxCategoryCode,
    attributeValues: content.attributeValues,
    variants: content.variants.map((variant) => ({
      variantId: variant.variantId,
      position: variant.position,
      optionValues: variant.optionValues,
      labels: variant.labels,
      gtin: variant.gtin,
      shippingWeightGrams: variant.shippingWeightGrams,
      shippingLengthMm: variant.shippingLengthMm,
      shippingWidthMm: variant.shippingWidthMm,
      shippingHeightMm: variant.shippingHeightMm,
      imageIds: variant.imageIds,
    })),
    imageIds: content.imageIds,
  };
}

const historyView = (entry: RevisionHistoryEntry): AdminRevisionHistoryView => ({
  revisionId: entry.revisionId,
  revisionNo: entry.revisionNo,
  kind: entry.kind,
  authorKind: entry.authorKind,
  submittedAt: entry.submittedAt.toString(),
  decision:
    entry.decision === null
      ? null
      : { ...entry.decision, decidedAt: entry.decision.decidedAt.toString() },
});

/**
 * `revision.review-read` (catalog design 9.2; product version review B1): what a reviewer compares before a
 * decision on one revision of a seller's product: that revision's frozen content, the published
 * revision's content (null before the first publication), the product's state and version, and
 * the history of its revisions with their decisions. Rule: the key `catalog.product.view` and the
 * admin population. A missing or PLATFORM product is `product.not-found`; a revision of another
 * product is `revision.not-found`. The reviewer's free text and account ids are not returned. One
 * read-only unit (ADR-0025); the store-name call follows it.
 */
export class ProductRevisionAdminRead extends UseCase<
  ProductRevisionAdminReadInput,
  ProductRevisionAdminReadOutput,
  ProductRevisionAdminReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.revision-review-read',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductRevisionAdminReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductRevisionAdminReadInput,
  ): Promise<Result<ProductRevisionAdminReadOutput, ProductRevisionAdminReadFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId', 'revisionId']);
    if (!ids.ok) return ids;
    const productId = ids.value.productId as Id<'Product'>;
    const revisionId = ids.value.revisionId as Id<'ProductRevision'>;
    const { deps } = this;
    const read = await deps.unitOfWork.run<Loaded, never>(
      market,
      async () => {
        const product = await deps.products.findById(market, productId);
        const state = product?.state;
        if (state === undefined || state.scope !== 'SELLER' || state.ownerSellerId === null) {
          return ok({ found: 'product' });
        }
        const revision = await deps.revisions.find(market, productId, revisionId);
        if (revision === null) return ok({ found: 'revision' });
        const published =
          state.publishedRevisionId === null
            ? null
            : state.publishedRevisionId === revision.id
              ? revision
              : await deps.revisions.find(market, productId, state.publishedRevisionId);
        const history = await deps.revisions.history(market, productId, HISTORY_LIMIT);
        const pending = state.pendingRevisionId === revision.id;
        const gtins = [
          ...new Set(revision.content.variants.flatMap((v) => (v.gtin === null ? [] : [v.gtin]))),
        ];
        const duplicates =
          pending && gtins.length > 0
            ? await deps.gtinRegistry.duplicatesOf(market, productId, gtins)
            : [];
        return ok({
          found: 'both',
          state,
          sellerId: state.ownerSellerId,
          revision,
          published,
          history,
          pending,
          duplicates,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const value = read.value;
    if (value.found === 'product') return err({ code: 'product.not-found' });
    if (value.found === 'revision') return err({ code: 'revision.not-found' });
    const { state, revision, published, history, pending, duplicates, sellerId } = value;
    const names = await deps.sellerNames.storeNames(context, [sellerId]);
    const firstPublication = state.publishedRevisionId === null;
    const before = published?.content.topicIds ?? [];
    const after = revision.content.topicIds;
    const topicDiff = {
      added: after.filter((id) => !before.includes(id)),
      removed: before.filter((id) => !after.includes(id)),
    };
    let topicRefs: readonly TopicRef[] = [];
    const { topicReader, policy } = deps;
    if (topicReader !== undefined && policy !== undefined) {
      // The names are a convenience: a failed read leaves the ids, never the review.
      const refs = await deps.unitOfWork
        .run<readonly TopicRef[], never>(
          market,
          async () =>
            ok([
              ...(
                await topicRefsOf(
                  topicReader,
                  market,
                  [...before, ...after],
                  policy.locales(market).default,
                )
              ).values(),
            ]),
          { readOnly: true },
        )
        .catch(() => null);
      if (refs !== null && refs.ok) topicRefs = refs.value;
    }
    return ok({
      productId: state.id,
      productCode: state.productCode,
      typeCode: state.typeCode,
      status: state.status,
      version: state.version,
      sellerId,
      storeName: names.get(sellerId) ?? null,
      state: pending
        ? 'pending'
        : state.publishedRevisionId === revision.id
          ? 'published'
          : 'closed',
      firstPublication,
      reasons: revision.sensitiveReasons,
      requiredChecks: pending
        ? requiredChecksOf({ firstPublication, reasons: revision.sensitiveReasons })
        : [],
      warnings:
        duplicates.length === 0
          ? []
          : [
              duplicates.some((d) => d.scope === 'PLATFORM')
                ? 'gtin.duplicate-platform'
                : 'gtin.duplicate',
            ],
      revision: contentView(revision),
      topicRefs,
      topicDiff,
      published: published === null ? null : contentView(published),
      history: history.map(historyView),
    });
  }
}
