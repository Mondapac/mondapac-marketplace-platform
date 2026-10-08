import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { parseBusinessIdentifier, type IdentifierInvalid } from '../../domain/business-identifier';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import {
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
  type SellersUnavailable,
} from '../draft/draft-support';
import type { BusinessIdentifierSchemes } from '../ports/business-identifier-scheme';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** The identifier as the seller typed it. The request has no seller id or Market. */
export interface MyFileValidateIdentifierInput {
  readonly identifier?: unknown;
}

/** The identifier is acceptable: how people write it in the Market's scheme. Nothing is stored. */
export interface IdentifierValidated {
  readonly display: string;
}

export type MyFileValidateIdentifierFailure =
  | { readonly code: IdentifierInvalid }
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable;

export interface MyFileValidateIdentifierDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly identifierSchemes: BusinessIdentifierSchemes;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `my-file.validate-identifier` (sellers design 6.2, Reza 4; slice 3): the Seller Owner asks
 * whether a number is acceptable in the Market's scheme: format and checksum only, no lookup,
 * nothing stored, no file read. Rule `permissions [sellers.business-identity.edit]`, allowed while
 * the seller is not approved. It counts against the same saves limit as a save (6.5), so it is no
 * free oracle. The answer is `identifier.format` or `identifier.checksum` (codes only; the value
 * is never echoed, logged or kept), or the display form.
 */
export class MyFileValidateIdentifier extends UseCase<
  MyFileValidateIdentifierInput,
  IdentifierValidated,
  MyFileValidateIdentifierFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-validate-identifier',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileValidateIdentifierDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileValidateIdentifierInput,
  ): Promise<Result<IdentifierValidated, MyFileValidateIdentifierFailure>> {
    const result = await this.validate(context, input ?? {});
    logDraftOutcome(
      'my-file-validate-identifier',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'valid' : result.error.code,
    );
    return result;
  }

  private async validate(
    context: CallContext,
    input: MyFileValidateIdentifierInput,
  ): Promise<Result<IdentifierValidated, MyFileValidateIdentifierFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const scheme = this.deps.identifierSchemes.schemeOf(market);
    if (scheme === null) return err({ code: 'sellers.unavailable' });
    const parsed = parseBusinessIdentifier(input.identifier, scheme);
    if (!parsed.ok) return err({ code: parsed.error });
    return ok({ display: scheme.display(parsed.value.value) });
  }
}
