import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
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

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export type AttributeValuesMergeFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' }
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

type Output = { readonly attribute: AttributeWriteView };

export interface AttributeValuesMergeDependencies extends Omit<
  AttributeRestructureDependencies,
  'impact'
> {
  /** The review policy of area catalogue (whether the merge waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the merge for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

/**
 * `attribute-definition.merge-values` (attributes A8; plan ت۶): one value of a published select
 * attribute is merged into another. The source stays, inactive and marked "merged into" the
 * target; the storefront, the filters and the index read the target for it at read time; no
 * product revision changes, and a product's next save stores the target's code. The admin saw the
 * impact dialog first; the version he names is the one it showed (`attribute.stale` otherwise).
 * Rule: the key `catalog.attribute.restructure` (protected), the admin population, never in an
 * acting-as session. One unit: the revision, one audit row, and the attribute's open relaxation
 * request, which named the version before this one, is cancelled.
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): after the same domain step the answer is the proposal (`request`, with a
 * `note`) and nothing is written. The approval runs {@link mergeValuesInUnit} again
 * (catalogue-appliers.ts).
 */
export class AttributeValuesMerge extends UseCase<
  { readonly [key: string]: unknown },
  ProposedOr<Output>,
  AttributeValuesMergeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-values-merge',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeValuesMerge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeValuesMergeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeValuesMergeFailure>> {
    const result = await this.#merge(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-values-merge',
      code: result.ok ? ('attribute' in result.value ? 'merged' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #merge(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeValuesMergeFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId', 'version', 'source', 'target', 'note']);
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
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(deps.review, context);
    try {
      return await deps.unitOfWork.run<ProposedOr<Output>, AttributeValuesMergeFailure>(
        market,
        async () => {
          const found = await deps.attributeStore.findById(market, id);
          if (found === null) return err({ code: 'attribute.not-found' } as const);
          if (found.state.version !== version.value) {
            return err({ code: 'attribute.stale' } as const);
          }
          if (policy.reviewed) {
            const step = found.mergeValues({
              revisionId: deps.ids.next<'AttributeDefinitionRevision'>(),
              source,
              target,
              now: deps.clock.now(),
            });
            if (!step.ok) return err(domainFailureOf(step.error));
            const proposed = await proposeCatalogueAction(deps.proposer, context, policy, {
              subjectKind: ATTRIBUTE_RESTRUCTURE_SUBJECT_KIND,
              subjectRef: id,
              before: attributeStateValues(found),
              after: attributeActionValues({
                action: 'merge-values',
                version: version.value,
                source,
                target,
              }),
              note: body.value['note'],
              tooLargePath: 'source',
            });
            if (!proposed.ok) return err(proposed.error);
            const request = requestRef(proposed.value);
            if (request !== null) return ok({ request });
          }
          return mergeValuesInUnit(deps, context, found, { source, target }, null);
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}

/**
 * The merge of one value into another inside the open unit, on the definition as read in it: the
 * domain step, the revision, the audit row (naming the request whose approval ran it, null for an
 * admin's own merge) and the open relaxation request cancelled.
 */
export async function mergeValuesInUnit(
  deps: Omit<AttributeRestructureDependencies, 'impact'>,
  context: CallContext,
  found: AttributeDefinition,
  values: { readonly source: string; readonly target: string },
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Output, AttributeValuesMergeFailure>> {
  const { market } = context;
  const accountId = editorAccountOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const next = found.mergeValues({
    revisionId: deps.ids.next<'AttributeDefinitionRevision'>(),
    source: values.source,
    target: values.target,
    now: deps.clock.now(),
  });
  if (!next.ok) return err(domainFailureOf(next.error));
  await deps.attributeStore.saveRevision(market, next.value, accountId);
  await deps.audit.record(
    context,
    AttributeValuesMergedAudit.entry(found.state.id, {
      before: auditShapeOf(found),
      after: {
        ...auditShapeOf(next.value),
        mergedValueCount: next.value.state.options.filter(
          (option) => (option.mergedInto ?? null) !== null,
        ).length,
        requestId,
      },
    }),
  );
  await cancelOpenRelaxation(deps, context, market, found.state.id);
  return ok({ attribute: writeViewOf(next.value) });
}
