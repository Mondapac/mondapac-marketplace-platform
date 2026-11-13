import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { AttributeDefinitionConvertedAudit } from '../../domain/audit';
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

export type AttributeConvertFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' };

/**
 * `attribute-definition.convert` (attributes A8; plan ت۵): the type of a published attribute
 * changes along one of the listed paths: a whole number to a decimal, a select to a multi-select.
 * Both keep every stored value valid, so no product revision is rewritten; readers take the stored
 * value as the new type. Refused for a `material` attribute, a variant option, an archived or draft
 * one, and an attribute that others were merged into (the merged types must stay equal). The
 * version named is the one the impact dialog showed. Rule: the key
 * `catalog.attribute.restructure` (protected), the admin population, never in an acting-as
 * session. One unit: the revision, one audit row, and the attribute's open relaxation request is
 * cancelled.
 */
export class AttributeConvert extends UseCase<
  { readonly [key: string]: unknown },
  { readonly attribute: AttributeWriteView },
  AttributeConvertFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-convert',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeConvert');

  constructor(
    gate: UseCaseGate,
    private readonly deps: Omit<AttributeRestructureDependencies, 'impact'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeConvertFailure>> {
    const result = await this.#convert(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-convert',
      code: result.ok ? 'converted' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #convert(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeConvertFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId', 'version', 'to']);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const to = body.value['to'];
    if (typeof to !== 'string') return invalid('to', 'type');
    const { market } = context;
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<
        { readonly attribute: AttributeWriteView },
        AttributeConvertFailure
      >(market, async () => {
        const found = await deps.attributeStore.findById(market, id);
        if (found === null) return err({ code: 'attribute.not-found' } as const);
        if (found.state.version !== version.value) return err({ code: 'attribute.stale' } as const);
        if (!(await deps.attributeStore.lockAtVersion(market, id, version.value))) {
          return err({ code: 'attribute.stale' } as const);
        }
        if (await deps.attributeStore.hasMergedSources(market, id)) {
          return err({ code: 'attribute-definition.convert-merged' } as const);
        }
        const next = found.convertType({
          revisionId: deps.ids.next<'AttributeDefinitionRevision'>(),
          to,
          now: deps.clock.now(),
        });
        if (!next.ok) return err(domainFailureOf(next.error));
        await deps.attributeStore.saveConversion(market, next.value, accountId);
        await deps.audit.record(
          context,
          AttributeDefinitionConvertedAudit.entry(id, {
            before: { ...auditShapeOf(found), dataType: dataTypeOf(found.state.dataType) },
            after: { ...auditShapeOf(next.value), dataType: dataTypeOf(next.value.state.dataType) },
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

/** The audit keeps the four types a conversion moves between; anything else is a bug. */
function dataTypeOf(type: string): 'integer' | 'decimal' | 'select' | 'multi-select' {
  if (type === 'integer' || type === 'decimal' || type === 'select' || type === 'multi-select') {
    return type;
  }
  throw new Error(`attribute.convert: ${type} is not a type a conversion moves between`);
}
