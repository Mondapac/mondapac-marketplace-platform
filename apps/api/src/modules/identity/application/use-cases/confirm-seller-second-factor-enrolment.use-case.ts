import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  confirmSecondFactorEnrolment,
  type ConfirmSecondFactorEnrolmentDependencies,
  type ConfirmSecondFactorEnrolmentFailure,
  type ConfirmSecondFactorEnrolmentInput,
  type ConfirmSecondFactorEnrolmentOutput,
} from './confirm-second-factor-enrolment.use-case';

/**
 * The confirmation of a signed-in seller's enrolment (owner decision 2026-10-08: optional for a
 * seller at launch), begun by {@link StartSellerSecondFactorEnrolment}. Rule `anonymous` like
 * the admin's {@link ConfirmSecondFactorEnrolment}, whose steps it runs for the seller
 * population: the enrolment challenge's token binds the account (I1) and the code step refuses a
 * challenge of any other population. Every session of the account ends, as for an admin, so the
 * seller signs in again with the new factor, which proves the device before it is relied on.
 */
export class ConfirmSellerSecondFactorEnrolment extends UseCase<
  ConfirmSecondFactorEnrolmentInput,
  ConfirmSecondFactorEnrolmentOutput,
  ConfirmSecondFactorEnrolmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-seller-second-factor-enrolment',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('ConfirmSellerSecondFactorEnrolment');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ConfirmSecondFactorEnrolmentDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ConfirmSecondFactorEnrolmentInput,
  ): Promise<Result<ConfirmSecondFactorEnrolmentOutput, ConfirmSecondFactorEnrolmentFailure>> {
    return confirmSecondFactorEnrolment(this.deps, this.#logger, 'seller', context, input);
  }
}
