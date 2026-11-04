import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { AttributeRelaxationRequest } from '../../domain/attribute-relaxation-request';
import {
  AttributeRelaxationExpiredAudit,
  AttributeRelaxationRequestedAudit,
} from '../../domain/audit';
import {
  attributeIdOf,
  closedInput,
  domainFailureOf,
  editorAccountOf,
  versionOf,
  type DomainFailure,
  type FieldIssue,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import { relaxationViewOf, type RelaxationWriteView } from '../attributes/attribute-relaxation';
import {
  archiveBlockOf,
  type AttributeRestructureDependencies,
} from '../attributes/attribute-restructure';
import { RelaxationAlreadyOpenError } from '../ports/attribute-relaxation.store';

export type AttributeArchiveRequestFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' }
  | { readonly code: 'attribute.archive-blocked'; readonly fields: readonly FieldIssue[] }
  /** Only a `material` attribute is archived by a request; any other is archived at once. */
  | { readonly code: 'attribute.archive-not-material' }
  | { readonly code: 'relaxation.already-open' };

/**
 * `attribute-definition.request-archive` (catalog design 8.2; attributes A8): an admin asks to
 * archive a published `material` attribute. A different admin who holds
 * `catalog.attribute.restructure` confirms within 72 hours (`attribute-definition.confirm-archive`);
 * until then nothing changes. The checks that would refuse the archive (an active feature set,
 * live variants) are made now, so no one is asked to confirm what cannot happen, and again at the
 * confirm. The request names the attribute's version the admin saw. One open request per
 * attribute; a lapsed one is closed as expired first. Rule: the key
 * `catalog.attribute.restructure` (protected), the admin population, never in an acting-as
 * session. Lock order: the attribute, then the request.
 */
export class AttributeArchiveRequestCreate extends UseCase<
  { readonly [key: string]: unknown },
  { readonly request: RelaxationWriteView },
  AttributeArchiveRequestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-request-archive',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeArchiveRequestCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly request: RelaxationWriteView }, AttributeArchiveRequestFailure>> {
    const result = await this.#request(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-definition-request-archive',
      code: result.ok ? 'requested' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #request(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly request: RelaxationWriteView }, AttributeArchiveRequestFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId', 'version']);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<
        { readonly request: RelaxationWriteView },
        AttributeArchiveRequestFailure
      >(market, async () => {
        const definition = await deps.attributeStore.findById(market, id);
        if (definition === null) return err({ code: 'attribute.not-found' } as const);
        if (definition.state.version !== version.value) {
          return err({ code: 'attribute.stale' } as const);
        }
        const problem = definition.archivable();
        if (problem !== null) return err(domainFailureOf(problem));
        if (!definition.state.material) {
          return err({ code: 'attribute.archive-not-material' } as const);
        }
        if (!(await deps.attributeStore.lockAtVersion(market, id, version.value))) {
          return err({ code: 'attribute.stale' } as const);
        }
        const impact = await deps.impact.impactOf(market, {
          code: definition.state.code,
          isVariantOption: definition.state.isVariantOption,
        });
        const block = archiveBlockOf(definition, impact);
        if (block !== null)
          return err({
            code: 'attribute.archive-blocked',
            fields: [{ path: 'attribute', code: block }],
          } as const);
        const now = deps.clock.now();
        const open = await deps.relaxations.openOf(market, id);
        if (open !== null) {
          const expired = open.expire(now);
          if (!expired.ok) return err({ code: 'relaxation.already-open' } as const);
          try {
            await deps.relaxations.saveMove(market, expired.value);
            await deps.audit.record(
              context,
              AttributeRelaxationExpiredAudit.entry(id, {
                after: {
                  requestId: open.state.id,
                  requestedByAccountId: open.state.requestedByAccountId,
                },
              }),
            );
          } catch (error) {
            // Closed meanwhile by its requester or the expiry job: the new request goes on.
            if (!(error instanceof StaleAggregateError)) throw error;
          }
        }
        const request = AttributeRelaxationRequest.open({
          id: deps.ids.next<'AttributeRelaxationRequest'>(),
          marketId: market.marketId,
          definitionId: id,
          definitionVersion: version.value,
          kind: 'archive',
          requestedByAccountId: accountId,
          now,
        });
        await deps.relaxations.add(market, request);
        await deps.audit.record(
          context,
          AttributeRelaxationRequestedAudit.entry(id, {
            after: {
              requestId: request.state.id,
              kind: request.state.kind,
              definitionVersion: version.value,
              expiresAt: request.state.expiresAt,
            },
          }),
        );
        return ok({ request: relaxationViewOf(request) });
      });
    } catch (error) {
      if (error instanceof RelaxationAlreadyOpenError) {
        return err({ code: 'relaxation.already-open' });
      }
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}
