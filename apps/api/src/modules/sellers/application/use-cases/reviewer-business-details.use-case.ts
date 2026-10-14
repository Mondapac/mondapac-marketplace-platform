import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  ReviewerBusinessDetails,
  SellerDetailsNotFound,
  SellersUnavailable,
  SellersValidationFailed,
} from '../../contracts/sellers.facade';
import { SELLERS_BUSINESS_DETAILS_VIEW } from '../../contracts/permissions';
import { BusinessDetailsViewed } from '../../domain/audit';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { RevisionContentSealer } from '../ports/revision-content-sealer';

export interface ReviewerBusinessDetailsInput {
  readonly sellerId?: unknown;
}

export type ReviewerBusinessDetailsFailure =
  SellersValidationFailed | SellerDetailsNotFound | SellersUnavailable;

export interface ReviewerBusinessDetailsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
  readonly sealer: RevisionContentSealer;
  readonly audit: AuditWriter;
}

/**
 * `reviewerBusinessDetails` (sellers design 7.1, 9; board 13 item 3): the legal name, trading name
 * and addresses of a seller's **approved** revision, in clear, for a certification reviewer. Rule
 * `permissions [sellers.business-details.view]` (Hassan M4). The sealed content is read in a
 * read-only unit, opened outside any unit and checked against the revision's keyed hash; only then
 * does a read-write unit write the `sellers.business-details.viewed` audit row, and a refused row
 * means nothing is returned. An unknown id, an id of another Market (the read is Market-scoped) and
 * a seller with no approved revision are all `seller.details-not-found`. The log line holds the
 * outcome code, the Market and the correlation id; clear content never reaches a log, an event or
 * an audit row. Only the names and the two addresses leave: no phone, email or identifier.
 */
export class ReviewerBusinessDetailsRead extends UseCase<
  ReviewerBusinessDetailsInput,
  ReviewerBusinessDetails,
  ReviewerBusinessDetailsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.reviewer-business-details',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_DETAILS_VIEW.key] },
  };

  readonly #logger = new Logger('ReviewerBusinessDetails');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewerBusinessDetailsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewerBusinessDetailsInput,
  ): Promise<Result<ReviewerBusinessDetails, ReviewerBusinessDetailsFailure>> {
    const result = await this.read(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.reviewer-business-details',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: ReviewerBusinessDetailsInput,
  ): Promise<Result<ReviewerBusinessDetails, ReviewerBusinessDetailsFailure>> {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
    }
    const sellerId = parsed.value;
    const { market } = context;
    const { unitOfWork, revisions, sealer, audit } = this.deps;
    try {
      const loaded = await unitOfWork.run(
        market,
        async () => {
          const revision = await revisions.findApproved(market, sellerId);
          if (revision === null) return ok(null);
          const sealed = await revisions.readSealedContent(market, sellerId, revision.id);
          if (sealed === null) throw new Error('reviewer-business-details: no sealed content');
          return ok({ revision, sealed });
        },
        { readOnly: true },
      );
      if (!loaded.ok) return err({ code: 'sellers.unavailable' });
      if (loaded.value === null) return err({ code: 'seller.details-not-found' });
      const { revision, sealed } = loaded.value;

      const opened = await sealer.open(market, sellerId, sealed);
      if (!opened.ok) return this.refuse(market.marketId, revision.id, 'open-failed');
      const hashed = await sealer.hash(market, sellerId, opened.value);
      if (!hashed.ok || hashed.value !== revision.contentHash) {
        return this.refuse(market.marketId, revision.id, 'content-hash-mismatch');
      }

      // The audit row, in the unit of the read: refused, nothing is returned (design 9).
      const written = await unitOfWork.run(market, async () => {
        await audit.record(
          context,
          BusinessDetailsViewed.entry(sellerId, {
            after: {
              readKind: 'reviewer-details',
              revisionId: revision.id,
              previousRevisionId: null,
            },
          }),
        );
        return ok(undefined);
      });
      if (!written.ok) return err({ code: 'sellers.unavailable' });

      const content = opened.value;
      return ok({
        sellerId,
        revisionId: revision.id,
        businessName: content.businessName,
        storeName: content.storeName,
        operatingAddress: content.address,
        registeredAddress: content.registeredAddress,
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }

  /** A fixed, personal-data-free reason: a hash mismatch may mean tampering (Hassan, low). */
  private refuse(
    marketId: string,
    revisionId: string,
    reason: 'open-failed' | 'content-hash-mismatch',
  ): Result<never, SellersUnavailable> {
    this.#logger.warn({
      msg: 'sellers.reviewer-business-details-refused',
      reason,
      revisionId,
      marketId,
    });
    return err({ code: 'sellers.unavailable' });
  }
}
