import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
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
import type { AttributeDefinition } from '../../domain/attribute-definition';
import type { SystemActionProposer, SystemRequestRecorder } from '../../../system-requests';
import { attributeActionValues, attributeStateValues } from '../catalogue-actions';
import {
  ATTRIBUTE_RESTRUCTURE_SUBJECT_KIND,
  catalogueReview,
  proposeCatalogueAction,
  requestRef,
  type ProposedOr,
} from '../catalogue-review';
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
  | { readonly code: 'attribute.merge-blocked'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

type Output = { readonly attribute: AttributeWriteView };

export interface AttributeMergeDependencies extends AttributeRestructureDependencies {
  /** The review policy of area catalogue (whether the merge waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the merge for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

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
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): after the same checks the answer is the proposal (`request`, with a `note`; at
 * most 100 mapped values fit a request, more is `too-large-for-review`) and nothing is written.
 * The approval runs {@link checkMerge} and {@link writeMerge} again (catalogue-appliers.ts).
 */
export class AttributeMerge extends UseCase<
  { readonly [key: string]: unknown },
  ProposedOr<Output>,
  AttributeMergeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeMergeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeMergeFailure>> {
    const result = await this.#merge(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-merge',
      code: result.ok ? ('attribute' in result.value ? 'merged' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #merge(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeMergeFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, [
      'attributeId',
      'version',
      'target',
      'targetVersion',
      'options',
      'note',
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
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(deps.review, context);
    try {
      return await deps.unitOfWork.run<ProposedOr<Output>, AttributeMergeFailure>(
        market,
        async () => {
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
          const plan = await checkMerge(deps, market, source, target, mapping);
          if (!plan.ok) return plan;
          if (policy.reviewed) {
            const proposed = await proposeCatalogueAction(deps.proposer, context, policy, {
              subjectKind: ATTRIBUTE_RESTRUCTURE_SUBJECT_KIND,
              subjectRef: id,
              before: attributeStateValues(source),
              after: attributeActionValues({
                action: 'merge',
                version: version.value,
                targetId,
                targetVersion: targetVersion.value,
                options: mapping,
              }),
              note: body.value['note'],
              tooLargePath: 'options',
            });
            if (!proposed.ok) return err(proposed.error);
            const request = requestRef(proposed.value);
            if (request !== null) return ok({ request });
          }
          return writeMerge(deps, context, source, targetId, plan.value, null);
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}

type MergePlan = Extract<ReturnType<typeof planAttributeMerge>, { ok: true }>['value'];

/**
 * The checks of a merge inside the open unit, on both definitions as read in it: the domain's
 * plan, both rows held at the versions read (source then target by id), and nothing that blocks
 * archiving the source. Shared by the route and by the approval of a proposed merge.
 */
export async function checkMerge(
  deps: Pick<AttributeRestructureDependencies, 'attributeStore' | 'impact'>,
  market: MarketContext,
  source: AttributeDefinition,
  target: AttributeDefinition,
  mapping: Readonly<Record<string, string>>,
): Promise<Result<MergePlan, AttributeMergeFailure>> {
  const plan = planAttributeMerge(source, target, mapping);
  if (!plan.ok) return err(domainFailureOf(plan.error));
  // The lock order is the source then the target by id, so two merges never wait on each other.
  const [first, second] =
    source.state.id < target.state.id ? [source.state, target.state] : [target.state, source.state];
  if (!(await deps.attributeStore.lockAtVersion(market, first.id, first.version))) {
    return err({ code: 'attribute.stale' });
  }
  if (!(await deps.attributeStore.lockAtVersion(market, second.id, second.version))) {
    return err({ code: 'attribute.stale' });
  }
  const impact = await deps.impact.impactOf(market, {
    code: source.state.code,
    isVariantOption: source.state.isVariantOption,
  });
  const block = await archiveBlockWithMergesOf(deps, market, source, impact);
  if (block !== null) {
    return err({ code: 'attribute.merge-blocked', fields: [{ path: 'attribute', code: block }] });
  }
  return ok(plan.value);
}

/** The merge after {@link checkMerge}: the source archived and pointed at the target, audited. */
export async function writeMerge(
  deps: AttributeRestructureDependencies,
  context: CallContext,
  source: AttributeDefinition,
  targetId: Id<'AttributeDefinition'>,
  plan: MergePlan,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Output, AttributeMergeFailure>> {
  const { market } = context;
  const id = source.state.id;
  const archived = source.archive();
  if (!archived.ok) return err(domainFailureOf(archived.error));
  await deps.attributeStore.saveMerge(market, archived.value, targetId, plan);
  await deps.audit.record(
    context,
    AttributeDefinitionsMergedAudit.entry(id, {
      before: { status: 'active', material: false },
      after: {
        status: 'archived',
        mergedIntoId: targetId,
        mappedValueCount: plan.length,
        requestId,
      },
    }),
  );
  await cancelOpenRelaxation(deps, context, market, id);
  return ok({ attribute: writeViewOf(archived.value) });
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
