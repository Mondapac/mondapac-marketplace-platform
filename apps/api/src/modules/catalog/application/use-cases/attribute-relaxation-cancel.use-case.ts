import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import type { RelaxationRefusal } from '../../domain/attribute-relaxation-request';
import { AttributeRelaxationCancelledAudit } from '../../domain/audit';
import {
  closedInput,
  editorAccountOf,
  versionOf,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import {
  relaxationViewOf,
  requestIdOf,
  type AttributeRelaxationDependencies,
  type RelaxationWriteView,
} from '../attributes/attribute-relaxation';

export interface AttributeRelaxationCancelInput {
  readonly [key: string]: unknown;
}

export type AttributeRelaxationCancelFailure =
  | ValidationFailure
  | RelaxationRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'relaxation.not-found' }
  | { readonly code: 'relaxation.stale' };

/**
 * `attribute-definition.cancel-relaxation` (catalog design 8.2; attributes A2 part 3): the
 * requester withdraws their open request; nothing else changes. Another admin cannot cancel it
 * (`relaxation.not-requester`): they confirm it or let it expire. The request's version is the one
 * the admin saw (`relaxation.stale`). Rule: the key `catalog.attribute.edit` (protected), the
 * admin population, never in an acting-as session.
 */
export class AttributeRelaxationCancel extends UseCase<
  AttributeRelaxationCancelInput,
  { readonly request: RelaxationWriteView },
  AttributeRelaxationCancelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-relaxation-cancel',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeRelaxationCancel');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRelaxationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeRelaxationCancelInput,
  ): Promise<Result<{ readonly request: RelaxationWriteView }, AttributeRelaxationCancelFailure>> {
    const result = await this.#cancel(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-relaxation-cancel',
      code: result.ok ? 'cancelled' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #cancel(
    context: CallContext,
    input: AttributeRelaxationCancelInput,
  ): Promise<Result<{ readonly request: RelaxationWriteView }, AttributeRelaxationCancelFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['requestId', 'version']);
    if (!body.ok) return body;
    const requestId = requestIdOf(body.value['requestId']);
    if (requestId === null) return err({ code: 'relaxation.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<
        { readonly request: RelaxationWriteView },
        AttributeRelaxationCancelFailure
      >(market, async () => {
        const request = await deps.relaxations.findById(market, requestId);
        if (request === null) return err({ code: 'relaxation.not-found' } as const);
        const cancelled = request.cancel(accountId, deps.clock.now());
        if (!cancelled.ok) return err(cancelled.error);
        if (request.state.version !== version.value) {
          return err({ code: 'relaxation.stale' } as const);
        }
        await deps.relaxations.saveMove(market, cancelled.value);
        await deps.audit.record(
          context,
          AttributeRelaxationCancelledAudit.entry(request.state.definitionId, {
            after: { requestId, reason: 'requester' },
          }),
        );
        return ok({ request: relaxationViewOf(cancelled.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'relaxation.stale' });
      throw error;
    }
  }
}
