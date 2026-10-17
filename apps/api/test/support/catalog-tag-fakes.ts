import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import type {
  ClaimCheckUnavailable,
  ClaimEvaluator,
} from '../../src/modules/catalog/application/ports/claim-evaluator';
import {
  ClaimQueryBuilder,
  type PublishedSnapshot,
} from '../../src/modules/catalog/application/tags/claim-query-builder';
import type {
  ClaimFacts,
  OfferTagState,
  TagClaimQuery,
  TagDecision,
} from '../../src/modules/catalog/domain/offer-tag';
import type { Product } from '../../src/modules/catalog/domain/product';
import type { RevisionContent } from '../../src/modules/catalog/domain/revision-content';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';

// In-memory stand-ins for the claim path of catalog (slice 8): an evaluator that answers per
// query, a query builder over fixed facts and a recording outbox.

const EVALUATED_AT = Temporal.Instant.from('2026-10-17T01:00:00Z');

/** An allowed decision on the SELLER basis, echoing the query (inputs equal to it). */
export function allowedDecision(
  query: TagClaimQuery,
  ids: { certificateId: Id; versionId: Id; typeRevisionId: Id },
  overrides: Partial<TagDecision> = {},
): TagDecision {
  return {
    allowed: true,
    basis: 'SELLER',
    reason: 'allowed',
    certificate: {
      kind: 'seller',
      certificateId: ids.certificateId,
      versionId: ids.versionId,
      issuerId: null,
      typeRevisionId: ids.typeRevisionId,
      validUntil: null,
    },
    policyRevisionId: null,
    badge: {
      typeCode: query.typeCode,
      typeRevisionId: ids.typeRevisionId,
      basis: 'SELLER',
      sellerClaim: true,
      issuer: null,
      validUntilLocalDate: null,
      validUntilZone: null,
      verifiedWithIssuer: false,
      reviewedByPlatform: true,
    },
    inputs: query,
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  };
}

/** A refused decision with the given reason, echoing the query. */
export function refusedDecision(query: TagClaimQuery, reason: string): TagDecision {
  return {
    allowed: false,
    basis: null,
    reason,
    certificate: null,
    policyRevisionId: null,
    badge: null,
    inputs: query,
    evaluatedAt: EVALUATED_AT,
  };
}

/** An evaluator that answers each query with `decide`, or is unavailable; records each call. */
export class FakeClaimEvaluator implements ClaimEvaluator {
  readonly calls: TagClaimQuery[][] = [];
  unavailable = false;
  activeUnavailable = false;

  constructor(
    public decide: (query: TagClaimQuery) => TagDecision,
    public active: readonly string[],
  ) {}

  evaluate(
    _context: CallContext,
    queries: readonly TagClaimQuery[],
  ): Promise<Result<readonly TagDecision[], ClaimCheckUnavailable>> {
    this.calls.push([...queries]);
    if (this.unavailable) return Promise.resolve(err({ code: 'claim.check-unavailable' }));
    return Promise.resolve(ok(queries.map((query) => this.decide(query))));
  }

  activeTypeCodes(): Promise<Result<ReadonlySet<string>, ClaimCheckUnavailable>> {
    if (this.activeUnavailable) return Promise.resolve(err({ code: 'claim.check-unavailable' }));
    return Promise.resolve(ok(new Set(this.active)));
  }
}

/**
 * A `ClaimQueryBuilder` whose published facts are fixed (null: never published) and whose
 * revision facts name the revision given with the fixed variants and paths. Queries are built by
 * the real builder (the domain's `claimQueriesFor`).
 */
export class FixedFactsClaimQueryBuilder extends ClaimQueryBuilder {
  constructor(
    public published: ClaimFacts | null,
    public submitted: Omit<ClaimFacts, 'productRevisionId' | 'revisionPublished' | 'productId'> = {
      variantIds: published?.variantIds ?? [],
      platformCategoryPaths: published?.platformCategoryPaths ?? [],
    },
  ) {
    const unused = (): never => {
      throw new Error('FixedFactsClaimQueryBuilder: no repository');
    };
    super({
      products: { findById: unused } as never,
      revisions: { find: unused } as never,
      categoryPaths: { livePaths: unused },
    });
  }

  /** The product version each published read answers. */
  productVersion = 1;
  /** Published reads so far; `onPublishedRead` may change the fake before the n-th answer. */
  publishedReads = 0;
  onPublishedRead: ((read: number, fake: FixedFactsClaimQueryBuilder) => void) | null = null;

  override publishedFacts(): Promise<ClaimFacts | null> {
    return Promise.resolve(this.published);
  }

  override publishedFactsOf(): Promise<ClaimFacts | null> {
    return this.publishedSnapshot().then((snapshot) => snapshot.facts);
  }

  override publishedSnapshot(): Promise<PublishedSnapshot> {
    this.publishedReads += 1;
    this.onPublishedRead?.(this.publishedReads, this);
    return Promise.resolve({ facts: this.published, productVersion: this.productVersion });
  }

  override revisionFacts(
    _market: MarketContext,
    product: Product,
    revisionId: Id<'ProductRevision'>,
    _content: RevisionContent,
    published: boolean,
  ): Promise<ClaimFacts> {
    return Promise.resolve({
      productId: product.state.id,
      productRevisionId: revisionId,
      revisionPublished: published,
      variantIds: this.submitted.variantIds,
      platformCategoryPaths: this.submitted.platformCategoryPaths,
    });
  }
}

/** An outbox that records what was appended. */
export class RecordingOutbox implements OutboxWriter {
  readonly appended: PendingEvent[] = [];

  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    this.appended.push(...events);
    return Promise.resolve();
  }

  get types(): string[] {
    return this.appended.map((event) => event.type);
  }
}

/** The stored state of an `active` SELLER-basis tag whose copy matches {@link allowedDecision}. */
export function activeTagState(
  id: Id<'OfferTag'>,
  typeCode: string,
  certificate: { certificateId: Id; versionId: Id; typeRevisionId: Id },
  at: Temporal.Instant,
  overrides: Partial<OfferTagState> = {},
): OfferTagState {
  return {
    id,
    typeCode,
    status: 'active',
    copy: {
      basis: 'SELLER',
      certificateKind: 'seller',
      certificateId: certificate.certificateId,
      certificateVersionId: certificate.versionId,
      issuerId: null,
      typeRevisionId: certificate.typeRevisionId,
      policyRevisionId: null,
      validUntil: null,
    },
    badge: allowedDecision({ typeCode } as TagClaimQuery, certificate).badge,
    copyRevisionId: null,
    copyRevisionPublished: true,
    inputsHash: null,
    lastReasonCode: null,
    lastChangeCause: 'tag-add',
    evaluatedAt: at,
    statusChangedAt: at,
    changeSeq: 1,
    removedAt: null,
    removedByKind: null,
    removedByAccountId: null,
    createdAt: at,
    ...overrides,
  };
}
