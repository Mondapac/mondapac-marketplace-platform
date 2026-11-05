import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { planAttributeMerge } from '../../domain/attribute-definition';
import { AttributeDefinitionsMergedAudit } from '../../domain/audit';
import {
  attributeIdOf,
  closedInput,
  domainFailureOf,
  editorAccountOf,
  invalid,
  versionOf,
  writeViewOf,
  type AttributeWriteView,
  type DomainFailure,
  type FieldIssue,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import { cancelOpenRelaxation } from '../attributes/attribute-relaxation';
import {
  archiveBlockWithMergesOf,
  type AttributeRestructureDependencies,
} from '../attributes/attribute-restructure';

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export type AttributeMergeFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' }
  /** The source is still in an active feature set, or a variant attribute with live variants. */
  | { readonly code: 'attribute.merge-blocked'; readonly fields: readonly FieldIssue[] };

/**
 * `attribute-definition.merge` (attributes A8; plan ت۶): a published attribute is merged into
 * another of the same type. The source is archived and points at the target; every value of a
 * choice attribute goes to a value of the target (the admin maps them); the storefront, the filters and
 * the index read the target for the source at read time, no product revision changes, and a
 * product's next save stores the target's code. Refused for a `material` source (a second
 * administrator archives it), for a variant attribute with live variants (`live-variants`) and
 * while an active feature set lists the source (`in-feature-set`: take it out first, as for an
 * archive; the target is in the feature set that needs it). Both versions
 * are the ones the impact dialog showed. Rule: the key `catalog.attribute.restructure`
 * (protected), the admin population, never in an acting-as session. One unit that holds both rows.
 */
export class AttributeMerge extends UseCase<
  { readonly [key: string]: unknown },
  { readonly attribute: AttributeWriteView },
  AttributeMergeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeRestructureDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeMergeFailure>> {
    const result = await this.#merge(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-merge',
      code: result.ok ? 'merged' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #merge(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeMergeFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, [
      'attributeId',
      'version',
      'target',
      'targetVersion',
      'options',
    ]);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const targetId = attributeIdOf(body.value['target']);
    if (targetId === null) return invalid('target', 'type');
    const targetVersion = versionOf(body.value['targetVersion']);
    if (!targetVersion.ok) return invalid('targetVersion', 'type');
    const mapping = mappingOf(body.value['options']);
    if (mapping === null) return invalid('options', 'type');
    const { market } = context;
    const { deps } = this;
    try {
      return await deps.unitOfWork.run<
        { readonly attribute: AttributeWriteView },
        AttributeMergeFailure
      >(market, async () => {
        const source = await deps.attributeStore.findById(market, id);
        if (source === null) return err({ code: 'attribute.not-found' } as const);
        const target = await deps.attributeStore.findById(market, targetId);
        if (target === null) return err({ code: 'attribute.not-found' } as const);
        if (
          source.state.version !== version.value ||
          target.state.version !== targetVersion.value
        ) {
          return err({ code: 'attribute.stale' } as const);
        }
        const plan = planAttributeMerge(source, target, mapping);
        if (!plan.ok) return err(domainFailureOf(plan.error));
        // The lock order is the source then the target by id, so two merges never wait on each other.
        const [first, second] =
          source.state.id < target.state.id
            ? [source.state, target.state]
            : [target.state, source.state];
        if (!(await deps.attributeStore.lockAtVersion(market, first.id, first.version))) {
          return err({ code: 'attribute.stale' } as const);
        }
        if (!(await deps.attributeStore.lockAtVersion(market, second.id, second.version))) {
          return err({ code: 'attribute.stale' } as const);
        }
        const impact = await deps.impact.impactOf(market, {
          code: source.state.code,
          isVariantOption: source.state.isVariantOption,
        });
        const block = await archiveBlockWithMergesOf(deps, market, source, impact);
        if (block !== null) {
          return err({
            code: 'attribute.merge-blocked',
            fields: [{ path: 'attribute', code: block }],
          } as const);
        }
        const archived = source.archive();
        if (!archived.ok) return err(domainFailureOf(archived.error));
        await deps.attributeStore.saveMerge(market, archived.value, targetId, plan.value);
        await deps.audit.record(
          context,
          AttributeDefinitionsMergedAudit.entry(id, {
            before: { status: 'active', material: false },
            after: {
              status: 'archived',
              mergedIntoId: targetId,
              mappedValueCount: plan.value.length,
            },
          }),
        );
        await cancelOpenRelaxation(deps, context, market, id);
        return ok({ attribute: writeViewOf(archived.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}

/** The map of source value codes to target value codes, or null if it is not one. */
function mappingOf(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 500) return null;
  for (const [from, to] of entries) {
    if (!CODE.test(from) || typeof to !== 'string' || !CODE.test(to)) return null;
    out[from] = to;
  }
  return out;
}
