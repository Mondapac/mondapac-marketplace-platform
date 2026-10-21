import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import type {
  CertificationTypeName,
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
import type { OfferRepository } from '../../src/modules/catalog/application/ports/offer.repository';
import type {
  PendingCertificationReevaluation,
  PendingReevaluation,
  TagReevaluationRequestRepository,
} from '../../src/modules/catalog/application/ports/tag-reevaluation-requests';

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
  /** The context of each `evaluate` call, as received. */
  readonly contexts: CallContext[] = [];
  unavailable = false;
  activeUnavailable = false;

  constructor(
    public decide: (query: TagClaimQuery) => TagDecision,
    public active: readonly string[],
  ) {}

  evaluate(
    context: CallContext,
    queries: readonly TagClaimQuery[],
  ): Promise<Result<readonly TagDecision[], ClaimCheckUnavailable>> {
    this.contexts.push(context);
    this.calls.push([...queries]);
    if (this.unavailable) return Promise.resolve(err({ code: 'claim.check-unavailable' }));
    return Promise.resolve(ok(queries.map((query) => this.decide(query))));
  }

  activeTypeCodes(): Promise<Result<ReadonlySet<string>, ClaimCheckUnavailable>> {
    if (this.activeUnavailable) return Promise.resolve(err({ code: 'claim.check-unavailable' }));
    return Promise.resolve(ok(new Set(this.active)));
  }

  /** Type ids to codes for `typeCodeOf` (slice 14); `typesUnavailable` makes it unavailable. */
  readonly typeCodes = new Map<string, string>();
  typesUnavailable = false;

  /** Type names for `typeNames` by code; `namesUnavailable` makes it unavailable. */
  readonly names = new Map<string, CertificationTypeName>();
  namesUnavailable = false;
  readonly nameLocales: string[] = [];
  readonly nameContexts: CallContext[] = [];

  typeNames(
    context: CallContext,
    locale: string,
  ): Promise<Result<ReadonlyMap<string, CertificationTypeName>, ClaimCheckUnavailable>> {
    this.nameContexts.push(context);
    this.nameLocales.push(locale);
    if (this.namesUnavailable) return Promise.resolve(err({ code: 'claim.check-unavailable' }));
    return Promise.resolve(ok(new Map(this.names)));
  }

  typeCodeOf(
    _context: CallContext,
    typeId: string,
  ): Promise<Result<string | null, ClaimCheckUnavailable>> {
    if (this.typesUnavailable) return Promise.resolve(err({ code: 'claim.check-unavailable' }));
    return Promise.resolve(ok(this.typeCodes.get(typeId) ?? null));
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

  /** The product locks taken in write units (slice 11); `lockFails` makes the next ones fail. */
  locks = 0;
  lockFails = false;

  override lockProduct(): Promise<boolean> {
    this.locks += 1;
    return Promise.resolve(!this.lockFails);
  }

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

/** A fan-out queue that records the publish requests (slice 11). */
export class RecordingReevaluationRequests implements TagReevaluationRequestRepository {
  readonly requested: {
    readonly productId: Id<'Product'>;
    readonly productRevisionId: Id<'ProductRevision'>;
  }[] = [];

  requestForPublish(
    _market: MarketContext,
    request: {
      readonly productId: Id<'Product'>;
      readonly productRevisionId: Id<'ProductRevision'>;
    },
  ): Promise<void> {
    this.requested.push({
      productId: request.productId,
      productRevisionId: request.productRevisionId,
    });
    return Promise.resolve();
  }

  /** The certification-event requests written, in order (Hassan M2). */
  readonly events: {
    readonly cause: string;
    readonly subjectId: Id;
    readonly sourceEventId: Id;
  }[] = [];
  /**
   * The pending requests no run started, by `cause:subjectId`, with when each was written
   * (Hassan M2, N1).
   */
  readonly unstarted = new Map<string, Temporal.Instant>();

  requestForEvent(
    _market: MarketContext,
    request: { readonly cause: string; readonly subjectId: Id; readonly sourceEventId: Id },
  ): Promise<void> {
    this.events.push({
      cause: request.cause,
      subjectId: request.subjectId,
      sourceEventId: request.sourceEventId,
    });
    return Promise.resolve();
  }

  pendingUnstarted(
    _market: MarketContext,
    request: {
      readonly cause: string;
      readonly subjectId: Id;
      readonly createdAfter: Temporal.Instant;
    },
  ): Promise<boolean> {
    const createdAt = this.unstarted.get(`${request.cause}:${request.subjectId}`);
    return Promise.resolve(
      createdAt !== undefined && Temporal.Instant.compare(createdAt, request.createdAfter) > 0,
    );
  }

  listPendingEnding(): Promise<readonly PendingCertificationReevaluation[]> {
    return Promise.resolve([]);
  }

  listPending(): Promise<readonly PendingReevaluation[]> {
    return Promise.resolve([]);
  }

  progress(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** An Offer store with no Offer on any product: what a PLATFORM publish marks is nothing. */
export const NO_OFFERS_ON_PRODUCT = {
  listOnProduct: () => Promise.resolve([]),
  save: () => Promise.reject(new Error('NO_OFFERS_ON_PRODUCT: nothing to save')),
} as unknown as OfferRepository;

/**
 * A request store that lists only the pending requests a test owns (slice 12): the database
 * specs share one database and run in parallel, so a job run of one file must not settle another
 * file's requests with its own fake evaluator. Every other method is the store's own.
 */
export function ownedRequests(
  store: TagReevaluationRequestRepository,
  owns: (request: PendingReevaluation) => boolean,
): TagReevaluationRequestRepository {
  return {
    requestForPublish: (...args) => store.requestForPublish(...args),
    requestForEvent: (...args) => store.requestForEvent(...args),
    pendingUnstarted: (...args) => store.pendingUnstarted(...args),
    listPending: async (market, limit) =>
      (await store.listPending(market, 1000)).filter(owns).slice(0, limit),
    listPendingEnding: async (market, page) =>
      (await store.listPendingEnding(market, { ...page, limit: 1000 }))
        .filter(owns)
        .slice(0, page.limit),
    progress: (...args) => store.progress(...args),
    close: (...args) => store.close(...args),
  };
}
