import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { AttributeDefinitionArchivedAudit } from '../../domain/audit';
import {
  attributeIdOf,
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
import { cancelOpenRelaxation } from '../attributes/attribute-relaxation';
import {
  archiveBlockOf,
  type AttributeRestructureDependencies,
} from '../attributes/attribute-restructure';

export type AttributeArchiveFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' }
  /** Still in an active feature set, or a variant attribute with live variants. */
  | { readonly code: 'attribute.archive-blocked'; readonly fields: readonly FieldIssue[] }
  /** A `material` attribute is archived by a request and a second administrator. */
  | { readonly code: 'attribute.archive-needs-second-admin' };

/**
 * `attribute-definition.archive` (attributes A8): a published attribute is archived. Products
 * that carry its values keep them. Refused while an active feature set lists it
 * (`attribute.archive-blocked`, `fields[0].code` `in-feature-set`), for a variant attribute with live
 * variants (`live-variants`), and for a `material` attribute, which needs a request and a
 * second administrator (`attribute.archive-needs-second-admin`; see the archive request use
 * cases). Nothing is deleted (Q-K6). Rule: the key `catalog.attribute.restructure` (protected),
 * the admin population, never in an acting-as session. One unit that holds the attribute's row
 * while it reads the impact.
 */
export class AttributeArchive extends UseCase<
  { readonly [key: string]: unknown },
  { readonly attribute: AttributeWriteView },
  AttributeArchiveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-archive',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeArchive');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeArchiveFailure>> {
    const result = await this.#archive(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-definition-archive',
      code: result.ok ? 'archived' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #archive(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeArchiveFailure>> {
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
        { readonly attribute: AttributeWriteView },
        AttributeArchiveFailure
      >(market, async () => {
        const found = await deps.attributeStore.findById(market, id);
        if (found === null) return err({ code: 'attribute.not-found' } as const);
        if (found.state.version !== version.value) return err({ code: 'attribute.stale' } as const);
        const problem = found.archivable();
        if (problem !== null) return err(domainFailureOf(problem));
        if (found.state.material) {
          return err({ code: 'attribute.archive-needs-second-admin' } as const);
        }
        if (!(await deps.attributeStore.lockAtVersion(market, id, version.value))) {
          return err({ code: 'attribute.stale' } as const);
        }
        const impact = await deps.impact.impactOf(market, {
          code: found.state.code,
          isVariantOption: found.state.isVariantOption,
        });
        const block = archiveBlockOf(found, impact);
        if (block !== null)
          return err({
            code: 'attribute.archive-blocked',
            fields: [{ path: 'attribute', code: block }],
          } as const);
        const next = found.archive();
        if (!next.ok) return err(domainFailureOf(next.error));
        await deps.attributeStore.saveStatus(market, next.value);
        await deps.audit.record(
          context,
          AttributeDefinitionArchivedAudit.entry(id, {
            before: { status: 'active', material: false },
            after: { status: 'archived', relaxationRequestId: null, requestedByAccountId: null },
          }),
        );
        await cancelOpenRelaxation(deps, context, market, id);
        return ok({ attribute: writeViewOf(next.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}
