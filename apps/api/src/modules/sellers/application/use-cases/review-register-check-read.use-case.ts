import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_FILE_REVIEW } from '../../contracts/permissions';
import {
  blocksApproval,
  blocksSubmit,
  registerStateOf,
  type RegisterCheckerKind,
  type RegisterMismatch,
  type RegisterState,
} from '../../domain/register-check';
import type { AccessUnavailable } from '../draft/draft-support';
import type { FileNotFound } from '../draft/draft-view';
import type { RegisterCheckRepository } from '../ports/register-check.repository';
import type { RegisterLookupPolicy } from '../ports/register-lookup-policy';
import type { SellerFileRepository } from '../ports/seller-file.repository';

/** The seller whose file is read: from the path of the admin route. */
export interface ReviewRegisterCheckReadInput {
  readonly sellerId?: unknown;
}

/**
 * The register state of a file's current identifier, as a reviewer sees it (design 3.4, 7.7,
 * ux 3.2a). **No register value and no business data**: the outcome, the mismatch flags and the
 * instants are results kept in clear (Q-M8), so no key is used and the read is not one of the
 * audited decrypting reads (design 9).
 */
export interface ReviewRegisterCheckView {
  /** `none`: the Market has no register lookup ("record a manual check", ux 3.2a). */
  readonly lookup: 'configured' | 'none';
  /** Whether the file holds an identifier of the Market's scheme to check. */
  readonly identifierSaved: boolean;
  /** `not-performed` when there is no result, the Market has no lookup or no identifier is saved. */
  readonly state: RegisterState;
  readonly mismatches: readonly RegisterMismatch[];
  /** ISO instant of the latest answer, or null. */
  readonly checkedAt: string | null;
  readonly checkedBy: RegisterCheckerKind | null;
  /** A definite negative closes the submission (AC 31). */
  readonly blocksSubmit: boolean;
  /** Approval is blocked on this state until a manual register check is recorded (AC 32). */
  readonly blocksApproval: boolean;
}

export type ReviewRegisterCheckReadFailure = FileNotFound | AccessUnavailable;

export interface ReviewRegisterCheckReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly registerChecks: RegisterCheckRepository;
  readonly registerPolicy: RegisterLookupPolicy;
  readonly clock: Clock;
}

/**
 * `review.register-check-read` (sellers design 6.2, 7.7; slice 4a): a reviewer reads the register
 * state of one seller's current identifier. Rule `permissions [sellers.seller-file.review]`
 * (platform scope). The seller id comes from the path and is read with the request's Market, so a
 * seller of another Market, an unknown id and a malformed id are all `file.not-found`,
 * byte-identical (AC 1). It never calls the register (the re-lookup is slice 7a-read) and never
 * decrypts anything; the manual link needs the identifier in clear and waits for
 * `sellers.business-details.view` (7a-read). Read in one read-only unit (ADR-0025).
 */
export class ReviewRegisterCheckRead extends UseCase<
  ReviewRegisterCheckReadInput,
  ReviewRegisterCheckView,
  ReviewRegisterCheckReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.review-register-check-read',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_FILE_REVIEW.key] },
  };

  readonly #logger = new Logger('ReviewRegisterCheckRead');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewRegisterCheckReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewRegisterCheckReadInput,
  ): Promise<Result<ReviewRegisterCheckView, ReviewRegisterCheckReadFailure>> {
    const result = await this.read(context, input ?? {});
    this.#logger.log({
      msg: 'sellers.review-register-check-read',
      code: result.ok ? result.value.state : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: ReviewRegisterCheckReadInput,
  ): Promise<Result<ReviewRegisterCheckView, ReviewRegisterCheckReadFailure>> {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'file.not-found' });
    const sellerId = parsed.value;
    const { market } = context;
    const { unitOfWork, files, registerChecks, registerPolicy, clock } = this.deps;
    const settings = registerPolicy.settingsOf(market);

    try {
      const read = await unitOfWork.run(
        market,
        async () => {
          const file = await files.findById(market, sellerId);
          if (file === null) return ok(null);
          const index = file.state.draft.identifier?.index ?? null;
          const check =
            settings.kind === 'configured' && index !== null
              ? await registerChecks.find(market, sellerId, index)
              : null;
          return ok({ identifierSaved: index !== null, check });
        },
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      if (read.value === null) return err({ code: 'file.not-found' });
      const { identifierSaved, check } = read.value;
      const state =
        settings.kind === 'configured'
          ? registerStateOf(check, clock.now(), settings.maxResultAgeDays)
          : 'not-performed';
      return ok({
        lookup: settings.kind === 'configured' ? 'configured' : 'none',
        identifierSaved,
        state,
        mismatches: state === 'active' && check !== null ? check.mismatches : [],
        checkedAt: state === 'not-performed' || check === null ? null : check.checkedAt.toString(),
        checkedBy: state === 'not-performed' || check === null ? null : check.checkedBy.kind,
        blocksSubmit: blocksSubmit(state),
        blocksApproval: blocksApproval(state, false),
      });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
