import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_DETAILS_VIEW } from '../../contracts/permissions';
import { BusinessDetailsViewed } from '../../domain/audit';
import type {
  BusinessFileContent,
  BusinessFileRevision,
  RegisterSnapshotOutcome,
} from '../../domain/business-file-revision';
import {
  blocksApproval,
  registerStateOf,
  staleReasonOf,
  type RegisterCheck,
  type RegisterMismatch,
  type RegisterStaleReason,
  type RegisterState,
} from '../../domain/register-check';
import type { RevisionKind } from '../../domain/revision-kinds';
import type { RevisionStatus } from '../../domain/business-file-revision';
import type { AccessState } from '../../domain/seller-status';
import type { SealedRevisionContent } from '../../domain/sealed';
import type { AccessUnavailable, SellersUnavailable } from '../draft/draft-support';
import type { FileNotFound } from '../draft/draft-view';
import type { BusinessIdentifierSchemes } from '../ports/business-identifier-scheme';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { RegisterCheckRepository } from '../ports/register-check.repository';
import type { RegisterLookupPolicy } from '../ports/register-lookup-policy';
import type { RevisionContentSealer } from '../ports/revision-content-sealer';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerFileRepository } from '../ports/seller-file.repository';

/** The seller whose file is reviewed: from the path of the admin route. */
export interface ReviewReadInput {
  readonly sellerId?: unknown;
}

/**
 * One revision as the reviewer sees it, **in clear**: personal data end to end. The HTTP slice
 * answers it with `Cache-Control: no-store` (design 8.3); it never reaches a log, an event or an
 * audit row.
 */
export interface ReviewRevisionView {
  readonly id: string;
  readonly kind: RevisionKind;
  readonly revisionNo: number;
  readonly status: RevisionStatus;
  readonly createdAt: Temporal.Instant;
  readonly serviceAreaCode: string;
  readonly operatingTimezone: string;
  /** The register answer the submission recorded (design 3.4), never a register value. */
  readonly registerAtSubmission: {
    readonly outcome: RegisterSnapshotOutcome;
    readonly mismatches: readonly RegisterMismatch[];
    readonly checkedAt: Temporal.Instant | null;
  };
  readonly content: {
    readonly storeName: string;
    readonly businessName: string;
    readonly phone: string;
    readonly contactEmail: string | null;
    readonly address: Readonly<Record<string, string>>;
    readonly registeredAddress: Readonly<Record<string, string>> | null;
    readonly identifier: {
      readonly scheme: string;
      readonly value: string;
      readonly display: string;
    } | null;
    readonly registeredForIndirectTax: boolean | null;
  };
}

/** Where the revision's identifier stands against the register now (design 3.4, 7.7). */
export interface ReviewRegisterView {
  readonly lookup: 'configured' | 'none';
  readonly state: RegisterState;
  readonly mismatches: readonly RegisterMismatch[];
  readonly staleReason: RegisterStaleReason | null;
  readonly checkedAt: Temporal.Instant | null;
  /** Approval is blocked on this state until a manual register check is recorded (AC 31, 32). */
  readonly blocksApproval: boolean;
}

export interface ReviewView {
  readonly sellerId: string;
  /** `identity`'s state, read live. */
  readonly access: AccessState;
  /** The revision under review: the pending one, else the latest. */
  readonly current: ReviewRevisionView;
  /** The approved revision shown beside a pending identity change; null otherwise. */
  readonly previous: ReviewRevisionView | null;
  readonly register: ReviewRegisterView;
}

export type ReviewReadFailure =
  FileNotFound | AccessUnavailable | SellersUnavailable | { readonly code: 'review.no-revision' };

export interface ReviewReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly sealer: RevisionContentSealer;
  readonly registerChecks: RegisterCheckRepository;
  readonly registerPolicy: RegisterLookupPolicy;
  readonly accessReader: SellerAccessReader;
  readonly identifierSchemes: BusinessIdentifierSchemes;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

interface Loaded {
  readonly current: BusinessFileRevision;
  readonly previous: BusinessFileRevision | null;
  readonly currentSealed: SealedRevisionContent;
  readonly previousSealed: SealedRevisionContent | null;
  readonly check: RegisterCheck | null;
  readonly fileChangedAt: Temporal.Instant;
  readonly fileVersion: number;
}

/**
 * `review.read` (sellers design 6.2, 8.3, 9; slice 7a-read): the review page of one seller. Rule
 * `permissions [sellers.business-details.view]`; the default role mapping puts that key beside
 * `identity.seller-access.approve` (design 6.2, Hassan M4). The seller id comes from the path
 * and is read with the request's Market, so a seller of another Market, an unknown id and a
 * malformed id are all `file.not-found`, byte-identical (AC 1).
 *
 * What it returns: the revision under review (the pending one, else the latest) and, beside a
 * pending identity change, the approved one; no history beyond these two (design 6.2). The sealed
 * content is read in a read-only unit, opened outside any unit (PP 3.1 row 5), checked against
 * the revision's keyed hash, and only then does a read-write unit write the
 * `sellers.business-details.viewed` audit row: when that row is refused nothing is returned.
 * Clear content is never logged; the log line holds the outcome code, the Market and the
 * correlation id.
 */
export class ReviewRead extends UseCase<ReviewReadInput, ReviewView, ReviewReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.review-read',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_DETAILS_VIEW.key] },
  };

  readonly #logger = new Logger('ReviewRead');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewReadInput,
  ): Promise<Result<ReviewView, ReviewReadFailure>> {
    const result = await this.read(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.review-read',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: ReviewReadInput,
  ): Promise<Result<ReviewView, ReviewReadFailure>> {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'file.not-found' });
    const sellerId = parsed.value;
    const { market } = context;
    const { unitOfWork, accessReader } = this.deps;

    let access: AccessState | null;
    try {
      access = await accessReader.accessOf(context, sellerId);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    if (access === null) return err({ code: 'file.not-found' });

    try {
      const loaded = await unitOfWork.run(market, () => this.load(market, sellerId), {
        readOnly: true,
      });
      if (!loaded.ok) return err({ code: 'access.unavailable' });
      if (loaded.value === 'no-file') return err({ code: 'file.not-found' });
      if (loaded.value === 'no-revision') return err({ code: 'review.no-revision' });
      const data = loaded.value;

      const current = await this.open(market, sellerId, data.current, data.currentSealed);
      const previous =
        data.previous === null || data.previousSealed === null
          ? null
          : await this.open(market, sellerId, data.previous, data.previousSealed);
      if (current === null || (data.previous !== null && previous === null)) {
        return err({ code: 'sellers.unavailable' });
      }

      // The audit row, in the unit of the read: refused, nothing is returned (design 9).
      const written = await unitOfWork.run(market, async () => {
        await this.deps.audit.record(
          context,
          BusinessDetailsViewed.entry(sellerId, {
            after: {
              readKind: 'review',
              revisionId: data.current.id,
              previousRevisionId: data.previous?.id ?? null,
            },
          }),
        );
        return ok(undefined);
      });
      if (!written.ok) return err({ code: 'access.unavailable' });

      return ok({
        sellerId,
        access,
        current,
        previous,
        register: this.registerOf(market, data),
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }

  private async load(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<Loaded | 'no-file' | 'no-revision', never>> {
    const { files, revisions, registerChecks, registerPolicy } = this.deps;
    const file = await files.findById(market, sellerId);
    if (file === null) return ok('no-file');
    const pending = await revisions.findPending(market, sellerId);
    const current = pending ?? (await revisions.findLatest(market, sellerId));
    if (current === null) return ok('no-revision');
    const approved = await revisions.findApproved(market, sellerId);
    const previous = approved !== null && approved.id !== current.id ? approved : null;
    const currentSealed = await revisions.readSealedContent(market, sellerId, current.id);
    const previousSealed =
      previous === null ? null : await revisions.readSealedContent(market, sellerId, previous.id);
    if (currentSealed === null || (previous !== null && previousSealed === null)) {
      throw new Error('review-read: a revision without its sealed content');
    }
    const settings = registerPolicy.settingsOf(market);
    const check =
      settings.kind === 'configured' && current.identifierIndex !== null
        ? await registerChecks.find(market, sellerId, current.identifierIndex)
        : null;
    return ok({
      current,
      previous,
      currentSealed,
      previousSealed,
      check,
      fileChangedAt: file.state.lastChangedAt,
      fileVersion: file.state.version,
    });
  }

  /** Opens a revision's content and checks it against the keyed hash the revision recorded. */
  private async open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revision: BusinessFileRevision,
    sealed: SealedRevisionContent,
  ): Promise<ReviewRevisionView | null> {
    const { sealer, identifierSchemes } = this.deps;
    // A fixed, personal-data-free reason: a hash mismatch may mean the stored content was tampered
    // with, so it must be visible in the log (Hassan, low).
    const refuse = (reason: 'open-failed' | 'content-hash-mismatch'): null => {
      this.#logger.warn({
        msg: 'sellers.review-read-refused',
        reason,
        revisionId: revision.id,
        marketId: market.marketId,
      });
      return null;
    };
    const opened = await sealer.open(market, sellerId, sealed);
    if (!opened.ok) return refuse('open-failed');
    const hashed = await sealer.hash(market, sellerId, opened.value);
    if (!hashed.ok || hashed.value !== revision.contentHash) return refuse('content-hash-mismatch');
    const scheme = identifierSchemes.schemeOf(market);
    return {
      id: revision.id,
      kind: revision.kind,
      revisionNo: revision.revisionNo,
      status: revision.status,
      createdAt: revision.createdAt,
      serviceAreaCode: revision.serviceAreaCode,
      operatingTimezone: revision.operatingTimezone,
      registerAtSubmission: {
        outcome: revision.register.outcome,
        mismatches: revision.register.mismatches,
        checkedAt: revision.register.checkedAt,
      },
      content: contentView(opened.value, scheme),
    };
  }

  private registerOf(market: MarketContext, data: Loaded): ReviewRegisterView {
    const settings = this.deps.registerPolicy.settingsOf(market);
    if (settings.kind !== 'configured') {
      return {
        lookup: 'none',
        state: 'not-performed',
        mismatches: [],
        staleReason: null,
        checkedAt: null,
        blocksApproval: blocksApproval('not-performed', false),
      };
    }
    const now = this.deps.clock.now();
    const { check, fileChangedAt, fileVersion } = data;
    const state = registerStateOf(
      check,
      now,
      settings.maxResultAgeDays,
      fileChangedAt,
      fileVersion,
    );
    return {
      lookup: 'configured',
      state,
      mismatches: state === 'active' && check !== null ? check.mismatches : [],
      staleReason:
        state === 'stale'
          ? staleReasonOf(check, now, settings.maxResultAgeDays, fileChangedAt, fileVersion)
          : null,
      checkedAt: state === 'not-performed' || check === null ? null : check.checkedAt,
      blocksApproval: blocksApproval(state, false),
    };
  }
}

function contentView(
  content: BusinessFileContent,
  scheme: ReturnType<BusinessIdentifierSchemes['schemeOf']>,
): ReviewRevisionView['content'] {
  return {
    storeName: content.storeName,
    businessName: content.businessName,
    phone: content.phone,
    contactEmail: content.contactEmail,
    address: content.address,
    registeredAddress: content.registeredAddress,
    identifier:
      content.identifier === null
        ? null
        : {
            scheme: content.identifier.scheme,
            value: content.identifier.value,
            display:
              scheme?.scheme === content.identifier.scheme
                ? scheme.display(content.identifier.value)
                : content.identifier.value,
          },
    registeredForIndirectTax: content.registeredForIndirectTax,
  };
}
