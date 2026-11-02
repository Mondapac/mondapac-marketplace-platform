import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
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
  invalid,
  versionOf,
  type DomainFailure,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import {
  relaxationViewOf,
  type AttributeRelaxationDependencies,
  type RelaxationWriteView,
} from '../attributes/attribute-relaxation';
import {
  RelaxationAlreadyOpenError,
  type AttributeRelaxationStore,
} from '../ports/attribute-relaxation.store';

export interface AttributeRelaxationRequestInput {
  readonly [key: string]: unknown;
}

export type AttributeRelaxationRequestFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' }
  | { readonly code: 'relaxation.already-open' };

/** The kinds a request may name today (the others arrive with their use cases). */
const KINDS_NOW: readonly string[] = ['clear-material'];

/**
 * `attribute-definition.request-relaxation` (catalog design 8.2; attributes A2 part 3): an admin
 * asks to clear `material` on a published attribute. A different admin with
 * `catalog.attribute.edit` confirms it within 72 hours; until then nothing changes. The request
 * names the attribute's version the admin saw (`attribute.stale` if it changed). One open request
 * per attribute (`relaxation.already-open`); an open one whose time ran out is closed as expired
 * first, so a new request never waits for the job. Rule: the key `catalog.attribute.edit`
 * (protected), the admin population, never in an acting-as session. Lock order: the attribute,
 * then the request.
 */
export class AttributeRelaxationRequestCreate extends UseCase<
  AttributeRelaxationRequestInput,
  { readonly request: RelaxationWriteView },
  AttributeRelaxationRequestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-relaxation-request',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeRelaxationRequestCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRelaxationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeRelaxationRequestInput,
  ): Promise<Result<{ readonly request: RelaxationWriteView }, AttributeRelaxationRequestFailure>> {
    const result = await this.#request(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-relaxation-request',
      code: result.ok ? 'requested' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #request(
    context: CallContext,
    input: AttributeRelaxationRequestInput,
  ): Promise<Result<{ readonly request: RelaxationWriteView }, AttributeRelaxationRequestFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId', 'version', 'kind']);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const kind = body.value['kind'];
    if (typeof kind !== 'string' || !KINDS_NOW.includes(kind)) return invalid('kind', 'unknown');
    const { market } = context;
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<
        { readonly request: RelaxationWriteView },
        AttributeRelaxationRequestFailure
      >(market, async () => {
        const definition = await deps.attributeStore.findById(market, id);
        if (definition === null) return err({ code: 'attribute.not-found' } as const);
        if (definition.state.version !== version.value) {
          return err({ code: 'attribute.stale' } as const);
        }
        const problem = definition.relaxableMaterial();
        if (problem !== null) return err(domainFailureOf(problem));
        if (!(await deps.attributeStore.lockAtVersion(market, id, version.value))) {
          return err({ code: 'attribute.stale' } as const);
        }
        const now = deps.clock.now();
        const open = await deps.relaxations.openOf(market, id);
        if (open !== null) {
          const expired = open.expire(now);
          if (!expired.ok) return err({ code: 'relaxation.already-open' } as const);
          if (await expireLapsed(deps.relaxations, market, expired.value)) {
            await deps.audit.record(
              context,
              AttributeRelaxationExpiredAudit.entry(id, {
                after: {
                  requestId: open.state.id,
                  requestedByAccountId: open.state.requestedByAccountId,
                },
              }),
            );
          }
        }
        const request = AttributeRelaxationRequest.open({
          id: deps.ids.next<'AttributeRelaxationRequest'>(),
          marketId: market.marketId,
          definitionId: id,
          definitionVersion: version.value,
          kind: 'clear-material',
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
      throw error;
    }
  }
}

/**
 * Store the lapsed request as expired, unless its requester or the expiry job closed it meanwhile
 * (neither locks the definition): then there is nothing to record and the new request goes on. The
 * open partial unique still refuses a second open request.
 */
async function expireLapsed(
  store: AttributeRelaxationStore,
  market: MarketContext,
  expired: AttributeRelaxationRequest,
): Promise<boolean> {
  try {
    await store.saveMove(market, expired);
    return true;
  } catch (error) {
    if (error instanceof StaleAggregateError) return false;
    throw error;
  }
}
