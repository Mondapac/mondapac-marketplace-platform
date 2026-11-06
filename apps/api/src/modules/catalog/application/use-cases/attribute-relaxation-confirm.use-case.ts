import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import type { RelaxationRefusal } from '../../domain/attribute-relaxation-request';
import { AttributeDefinitionRevisedAudit } from '../../domain/audit';
import {
  auditShapeOf,
  closedInput,
  domainFailureOf,
  editorAccountOf,
  versionOf,
  writeViewOf,
  type AttributeWriteView,
  type DomainFailure,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import {
  relaxationViewOf,
  requestIdOf,
  type AttributeRelaxationDependencies,
  type RelaxationWriteView,
} from '../attributes/attribute-relaxation';

export interface AttributeRelaxationConfirmInput {
  readonly [key: string]: unknown;
}

export interface AttributeRelaxationConfirmOutput {
  readonly request: RelaxationWriteView;
  readonly attribute: AttributeWriteView;
}

export type AttributeRelaxationConfirmFailure =
  | ValidationFailure
  | DomainFailure
  | RelaxationRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'relaxation.not-found' }
  | { readonly code: 'relaxation.stale' }
  | { readonly code: 'relaxation.attribute-changed' };

/**
 * `attribute-definition.confirm-relaxation` (catalog design 8.2; attributes A2 part 3): a second
 * admin confirms an open request, and `material` is cleared at once as the attribute's next
 * revision, which names the request. Refused for the requester (`relaxation.same-admin`; also a
 * CHECK on the row), after the request's time (`relaxation.expired`, by this unit's clock whatever
 * the job has done), for a request no longer open (`relaxation.closed`), when the request's
 * version is not the one the admin saw (`relaxation.stale`) and when the attribute changed since
 * the request (`relaxation.attribute-changed`). Rule: the key `catalog.attribute.edit`
 * (protected), the admin population, never in an acting-as session. One unit, in this order:
 * lock the attribute at the request's version, move the request, insert the revision (the
 * database refuses it without a confirmed request of this attribute), one audit row with both
 * account ids.
 */
export class AttributeRelaxationConfirm extends UseCase<
  AttributeRelaxationConfirmInput,
  AttributeRelaxationConfirmOutput,
  AttributeRelaxationConfirmFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-relaxation-confirm',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeRelaxationConfirm');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRelaxationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeRelaxationConfirmInput,
  ): Promise<Result<AttributeRelaxationConfirmOutput, AttributeRelaxationConfirmFailure>> {
    const result = await this.#confirm(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-relaxation-confirm',
      code: result.ok ? 'confirmed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #confirm(
    context: CallContext,
    input: AttributeRelaxationConfirmInput,
  ): Promise<Result<AttributeRelaxationConfirmOutput, AttributeRelaxationConfirmFailure>> {
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
        AttributeRelaxationConfirmOutput,
        AttributeRelaxationConfirmFailure
      >(market, async () => {
        const request = await deps.relaxations.findById(market, requestId);
        if (request === null || request.state.kind !== 'clear-material') {
          return err({ code: 'relaxation.not-found' } as const);
        }
        const now = deps.clock.now();
        // The domain's refusals first, so a closed or expired request says so whatever version
        // the admin saw.
        const confirmed = request.confirm(accountId, now);
        if (!confirmed.ok) return err(confirmed.error);
        if (request.state.version !== version.value) {
          return err({ code: 'relaxation.stale' } as const);
        }
        const definitionId = request.state.definitionId;
        const definition = await deps.attributeStore.findById(market, definitionId);
        if (
          definition === null ||
          definition.state.version !== request.state.definitionVersion ||
          !(await deps.attributeStore.lockAtVersion(
            market,
            definitionId,
            request.state.definitionVersion,
          ))
        ) {
          return err({ code: 'relaxation.attribute-changed' } as const);
        }
        const cleared = definition.clearMaterial({
          revisionId: deps.ids.next<'AttributeDefinitionRevision'>(),
          now,
        });
        if (!cleared.ok) return err(domainFailureOf(cleared.error));
        await deps.relaxations.saveMove(market, confirmed.value);
        await deps.attributeStore.saveRevision(market, cleared.value, accountId, requestId);
        await deps.audit.record(
          context,
          AttributeDefinitionRevisedAudit.entry(definitionId, {
            before: auditShapeOf(definition),
            after: {
              ...auditShapeOf(cleared.value),
              relaxationRequestId: requestId,
              requestedByAccountId: request.state.requestedByAccountId,
            },
          }),
        );
        return ok({
          request: relaxationViewOf(confirmed.value),
          attribute: writeViewOf(cleared.value),
        });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'relaxation.stale' });
      throw error;
    }
  }
}
