import { HttpException, Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { closedBody, refusalWith, type Refusal } from './http-answers';

/**
 * The HTTP status of each refusal of the type and issuer registry admin routes (slice 12). A
 * malformed request is 400; the actor who may not close this proposal (the proposer approving or
 * rejecting, another admin withdrawing) is 403; an unknown type, issuer or proposal is 404; a
 * row that moved, a transition the state refuses, a pending proposal, a taken name and a
 * confirmation count that no longer matches are 409; a revision or approval the rules refuse is
 * 422.
 */
export const ADMIN_REGISTRY_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'review.second-admin-required': 403,
  'review.proposer-cannot-reject': 403,
  'review.not-proposer': 403,
  'approval.same-admin': 403,
  'type.not-found': 404,
  'issuer.not-found': 404,
  'proposal.not-found': 404,
  'conflict.stale': 409,
  'review.proposal-pending': 409,
  'review.proposal-closed': 409,
  'type.already-inactive': 409,
  'type.already-active': 409,
  'type.revision-unchanged': 409,
  'claim-policy.revision-unchanged': 409,
  'issuer.transition-forbidden': 409,
  'issuer.reactivation-pending': 409,
  'issuer.reactivation-not-requested': 409,
  'issuer.confirmation-count-mismatch': 409,
  'issuer.name-taken': 409,
  'issuer.accreditation-taken': 409,
  'type.revision-invalid': 422,
  'claim-policy.revision-invalid': 422,
  'issuer.expert-approval-required': 422,
  'issuer.expert-approval-not-new': 422,
});

export const CSRF = {
  name: CSRF_HEADER,
  required: true,
  description: 'The CSRF token of the session',
};
export const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
export const SECOND_ADMIN =
  'review.second-admin-required (the requester may not approve), review.proposer-cannot-reject, ' +
  'review.not-proposer (only the requester withdraws), access.denied, request.csrf';

/** The settle and refusal steps every registry route shares: one log line, ids and codes only. */
export class RegistryHttp {
  readonly #logger: Logger;

  constructor(name: string) {
    this.#logger = new Logger(name);
  }

  answer<T extends object>(
    result: Result<T, Refusal>,
    response: Response,
    context: CallContext,
  ): T | HttpException {
    return result.ok
      ? result.value
      : refusalWith(
          ADMIN_REGISTRY_STATUS,
          result.error,
          response,
          context,
          'certification.admin-registry-unmapped-refusal',
        );
  }

  /** A closed JSON body, then the use case; a malformed body never reaches it. */
  async post<T extends object>(
    msg: string,
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
    keys: { readonly required: readonly string[]; readonly optional?: readonly string[] },
    run: (input: Record<string, unknown>) => Promise<Result<T, Refusal>>,
  ): Promise<T> {
    const input = closedBody(request, body, keys.required, keys.optional ?? []);
    const outcome =
      input instanceof HttpException ? input : this.answer(await run(input), response, context);
    return this.settle(msg, context, outcome);
  }

  settle<T extends object>(msg: string, context: CallContext, outcome: T | HttpException): T {
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
