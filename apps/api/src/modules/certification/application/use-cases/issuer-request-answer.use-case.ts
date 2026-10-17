import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerRequestAnsweredAudit } from '../../domain/audit';
import { IssuerRequestAnswered } from '../../domain/events';
import {
  answerRefusal,
  type IssuerRequestAnswerChoice,
  type IssuerRequestAnswerRefusal,
  type IssuerRequestOutcome,
} from '../../domain/issuer-request';
import {
  issuerRequestReasonsOf,
  parseIssuerId,
  parseIssuerRequestId,
  type IssuerRequestDependencies,
} from '../issuer-requests/issuer-request.shared';
import {
  invalid,
  reviewerOf,
  reviewFailure,
  type ValidationFailure,
} from '../review/review.shared';

export interface IssuerRequestAnswerInput {
  readonly issuerRequestId: unknown;
  /** The version the admin read; a request that moved since is `conflict.stale`. */
  readonly version: unknown;
  readonly outcome: unknown;
  /** For `issuer-added`: an active issuer of the request's type, created on its own path. */
  readonly issuerId?: unknown;
  /** For `not-accepted`: a reason code of the Market. */
  readonly reasonCode?: unknown;
}

export interface IssuerRequestAnswerOutput {
  readonly issuerRequestId: string;
  readonly version: number;
  readonly state: IssuerRequestOutcome;
  readonly answeredAt: string;
}

export type IssuerRequestAnswerFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'issuer-request.not-found' }
  | { readonly code: 'conflict.stale' }
  | IssuerRequestAnswerRefusal
  | ValidationFailure;

const OUTCOMES: readonly string[] = ['issuer-added', 'not-accepted'];

/**
 * `issuer-requests.answer` (certification design 2.1, 3.5, 8.3; brief s4 b 4): an admin answers an
 * open request once, under its version: the issuer was added (an `active` issuer of the request's
 * own type and Market, which the admin created in the registry on its own path, after the expert's
 * approval) or not accepted (a reason code of the Market). The answer has no name field: nothing of
 * the typed name reaches the registry, the event or the audit row (AC 11). One unit writes the
 * answer, `certification.issuer-request.answered` and `issuer-request-answered.v1` (the seller's
 * mail). Rule: key `certification.issuer.edit` (protected) and the admin population; an acting-as
 * session is refused.
 */
export class IssuerRequestAnswer extends UseCase<
  IssuerRequestAnswerInput,
  IssuerRequestAnswerOutput,
  IssuerRequestAnswerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-request-answer',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerRequestAnswerInput,
  ): Promise<Result<IssuerRequestAnswerOutput, IssuerRequestAnswerFailure>> {
    const admin = reviewerOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const id = parseIssuerRequestId(input.issuerRequestId);
    if (id === null) return invalid('issuerRequestId', 'format');
    if (
      typeof input.version !== 'number' ||
      !Number.isInteger(input.version) ||
      input.version < 1
    ) {
      return invalid('version', 'type');
    }
    const version = input.version;
    if (typeof input.outcome !== 'string' || !OUTCOMES.includes(input.outcome)) {
      return invalid('outcome', 'unknown');
    }
    let answer: IssuerRequestAnswerChoice;
    if (input.outcome === 'issuer-added') {
      if (input.reasonCode !== undefined && input.reasonCode !== null) {
        return invalid('reasonCode', 'not-allowed');
      }
      const issuerId = parseIssuerId(input.issuerId);
      if (issuerId === null) return invalid('issuerId', 'format');
      answer = { outcome: 'issuer-added', issuerId };
    } else {
      if (input.issuerId !== undefined && input.issuerId !== null) {
        return invalid('issuerId', 'not-allowed');
      }
      if (
        typeof input.reasonCode !== 'string' ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(input.reasonCode)
      ) {
        return invalid('reasonCode', 'format');
      }
      answer = { outcome: 'not-accepted', reasonCode: input.reasonCode };
    }

    const { deps } = this;
    const { market } = context;
    const reasons = issuerRequestReasonsOf(deps, market);
    const now = deps.clock.now();
    return deps.unitOfWork
      .run<IssuerRequestAnswerOutput, IssuerRequestAnswerFailure>(market, async () => {
        const request = await deps.requests.find(market, id);
        if (request === null) return err({ code: 'issuer-request.not-found' } as const);
        // An answered request says so, whatever version the caller read.
        if (request.state !== 'open') {
          return err({ code: 'issuer-request.already-answered' } as const);
        }
        if (request.version !== version) return err({ code: 'conflict.stale' } as const);
        const issuer =
          answer.outcome === 'issuer-added'
            ? await deps.types.issuer(market, answer.issuerId)
            : null;
        const refusal = answerRefusal({
          state: request.state,
          typeId: request.typeId,
          answer,
          issuer,
          reasonCodes: (reasons ?? []).map((reason) => reason.code),
        });
        if (refusal !== null) return err(refusal);

        const issuerId = answer.outcome === 'issuer-added' ? answer.issuerId : null;
        await deps.requests.answer(market, {
          id,
          expectedVersion: version,
          outcome: answer.outcome,
          issuerId,
          reasonCode: answer.outcome === 'not-accepted' ? answer.reasonCode : null,
          accountId: admin.accountId,
          answeredAt: now,
        });
        await deps.audit.record(
          context,
          IssuerRequestAnsweredAudit.entry(id, { after: { outcome: answer.outcome, issuerId } }),
        );
        await deps.outbox.append(context, [
          IssuerRequestAnswered.record({
            aggregateId: id,
            aggregateVersion: version + 1,
            occurredAt: now,
            payload: { issuerRequestId: id, sellerId: request.sellerId, outcome: answer.outcome },
          }),
        ]);
        return ok({
          issuerRequestId: id,
          version: version + 1,
          state: answer.outcome,
          answeredAt: now.toString(),
        });
      })
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.issuer-request-answer', error),
      );
  }
}
