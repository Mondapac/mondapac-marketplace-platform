import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { AttributeValuesMergedAudit } from '../../domain/audit';
import {
  attributeIdOf,
  auditShapeOf,
  closedInput,
  domainFailureOf,
  editorAccountOf,
  invalid,
  versionOf,
  writeViewOf,
  type AttributeWriteView,
  type DomainFailure,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import { cancelOpenRelaxation } from '../attributes/attribute-relaxation';
import type { AttributeRestructureDependencies } from '../attributes/attribute-restructure';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export type AttributeValuesMergeFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' };

/**
 * `attribute-definition.merge-values` (attributes A8; plan ت۶): one value of a published select
 * attribute is merged into another. The source stays, inactive and marked "merged into" the
 * target; the storefront, the filters and the index read the target for it at read time; no
 * product revision changes, and a product's next save stores the target's code. The admin saw the
 * impact dialog first; the version he names is the one it showed (`attribute.stale` otherwise).
 * Rule: the key `catalog.attribute.restructure` (protected), the admin population, never in an
 * acting-as session. One unit: the revision, one audit row, and the attribute's open relaxation
 * request, which named the version before this one, is cancelled.
 */
export class AttributeValuesMerge extends UseCase<
  { readonly [key: string]: unknown },
  { readonly attribute: AttributeWriteView },
  AttributeValuesMergeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-values-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeValuesMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: Omit<AttributeRestructureDependencies, 'impact'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeValuesMergeFailure>> {
    const result = await this.#merge(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-values-merge',
      code: result.ok ? 'merged' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #merge(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeValuesMergeFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId', 'version', 'source', 'target']);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const source = body.value['source'];
    const target = body.value['target'];
    if (typeof source !== 'string' || !CODE.test(source)) return invalid('source', 'type');
    if (typeof target !== 'string' || !CODE.test(target)) return invalid('target', 'type');
    const { market } = context;
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<
        { readonly attribute: AttributeWriteView },
        AttributeValuesMergeFailure
      >(market, async () => {
        const found = await deps.attributeStore.findById(market, id);
        if (found === null) return err({ code: 'attribute.not-found' } as const);
        if (found.state.version !== version.value) return err({ code: 'attribute.stale' } as const);
        const next = found.mergeValues({
          revisionId: deps.ids.next<'AttributeDefinitionRevision'>(),
          source,
          target,
          now: deps.clock.now(),
        });
        if (!next.ok) return err(domainFailureOf(next.error));
        await deps.attributeStore.saveRevision(market, next.value, accountId);
        await deps.audit.record(
          context,
          AttributeValuesMergedAudit.entry(id, {
            before: auditShapeOf(found),
            after: {
              ...auditShapeOf(next.value),
              mergedValueCount: next.value.state.options.filter(
                (option) => (option.mergedInto ?? null) !== null,
              ).length,
            },
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
