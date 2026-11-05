import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import type { RelaxationRefusal } from '../../domain/attribute-relaxation-request';
import { AttributeDefinitionArchivedAudit } from '../../domain/audit';
import {
  closedInput,
  domainFailureOf,
  editorAccountOf,
  versionOf,
  writeViewOf,
  type AttributeWriteView,
  type DomainFailure,
  type FieldIssue,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import {
  relaxationViewOf,
  requestIdOf,
  type RelaxationWriteView,
} from '../attributes/attribute-relaxation';
import {
  archiveBlockWithMergesOf,
  type AttributeRestructureDependencies,
} from '../attributes/attribute-restructure';

export interface AttributeArchiveConfirmOutput {
  readonly request: RelaxationWriteView;
  readonly attribute: AttributeWriteView;
}

export type AttributeArchiveConfirmFailure =
  | ValidationFailure
  | DomainFailure
  | RelaxationRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'relaxation.not-found' }
  | { readonly code: 'relaxation.stale' }
  | { readonly code: 'relaxation.attribute-changed' }
  | { readonly code: 'attribute.archive-blocked'; readonly fields: readonly FieldIssue[] };

/**
 * `attribute-definition.confirm-archive` (catalog design 8.2; attributes A8): a second admin
 * confirms an open archive request and the attribute is archived at once. The refusals are those
 * of the clear-material confirm (`relaxation.same-admin`, `.expired`, `.closed`, `.stale`,
 * `.attribute-changed`), and the archive checks are made again: an attribute that has joined an
 * active feature set since the request is `attribute.archive-blocked`. Rule: the key
 * `catalog.attribute.restructure` (protected), the admin population, never in an acting-as
 * session. One unit, in this order: lock the attribute at the request's version, move the request,
 * archive (the database refuses the archive of a `material` attribute without a confirmed archive
 * request of this attribute at this version), one audit row with the requester's account id.
 */
export class AttributeArchiveConfirm extends UseCase<
  { readonly [key: string]: unknown },
  AttributeArchiveConfirmOutput,
  AttributeArchiveConfirmFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-archive-confirm',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeArchiveConfirm');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<AttributeArchiveConfirmOutput, AttributeArchiveConfirmFailure>> {
    const result = await this.#confirm(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-archive-confirm',
      code: result.ok ? 'archived' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #confirm(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<AttributeArchiveConfirmOutput, AttributeArchiveConfirmFailure>> {
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
        AttributeArchiveConfirmOutput,
        AttributeArchiveConfirmFailure
      >(market, async () => {
        const request = await deps.relaxations.findById(market, requestId);
        if (request === null || request.state.kind !== 'archive') {
          return err({ code: 'relaxation.not-found' } as const);
        }
        const now = deps.clock.now();
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
        const impact = await deps.impact.impactOf(market, {
          code: definition.state.code,
          isVariantOption: definition.state.isVariantOption,
        });
        const block = await archiveBlockWithMergesOf(deps, market, definition, impact);
        if (block !== null)
          return err({
            code: 'attribute.archive-blocked',
            fields: [{ path: 'attribute', code: block }],
          } as const);
        const archived = definition.archive();
        if (!archived.ok) return err(domainFailureOf(archived.error));
        await deps.relaxations.saveMove(market, confirmed.value);
        await deps.attributeStore.saveStatus(market, archived.value);
        await deps.audit.record(
          context,
          AttributeDefinitionArchivedAudit.entry(definitionId, {
            before: { status: 'active', material: definition.state.material },
            after: {
              status: 'archived',
              relaxationRequestId: requestId,
              requestedByAccountId: request.state.requestedByAccountId,
            },
          }),
        );
        return ok({
          request: relaxationViewOf(confirmed.value),
          attribute: writeViewOf(archived.value),
        });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'relaxation.stale' });
      throw error;
    }
  }
}
