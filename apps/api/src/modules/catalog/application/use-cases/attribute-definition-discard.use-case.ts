import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { SystemActionProposer, SystemRequestRecorder } from '../../../system-requests';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import { AttributeDefinitionDiscardedAudit } from '../../domain/audit';
import {
  attributeIdOf,
  closedInput,
  domainFailureOf,
  editorAccountOf,
  versionOf,
  writeViewOf,
} from '../attributes/attribute-editor';
import type {
  AttributeDefinitionStatusDependencies,
  AttributeDefinitionStatusFailure,
  AttributeStatusOutput as Output,
} from '../attributes/attribute-status';
import { attributeActionValues, attributeStateValues } from '../catalogue-actions';
import {
  ATTRIBUTE_DISCARD_SUBJECT_KIND,
  catalogueReview,
  proposeCatalogueAction,
  requestRef,
  type ProposedOr,
} from '../catalogue-review';

export interface AttributeDefinitionDiscardDependencies extends AttributeDefinitionStatusDependencies {
  /** The review policy of area catalogue (whether the discard waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the discard for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

export type AttributeDefinitionDiscardFailure =
  | AttributeDefinitionStatusFailure
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

/**
 * `attribute-definition.discard` (attributes plan, package A2): a draft that was never published is
 * set aside. Rule as publish. Nothing is deleted (CA3): it becomes archived, its code stays taken
 * and its revisions stay readable. A published attribute cannot be discarded (archiving one is a
 * later package, with the two-person rule for a material one). One audit row.
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): the request needs a `note`, the domain step is checked as for a discard, and
 * the answer is the proposal (`request`) with nothing written. The approval runs
 * {@link discardAttributeInUnit} again (catalogue-appliers.ts).
 */
export class AttributeDefinitionDiscard extends UseCase<
  { readonly [key: string]: unknown },
  ProposedOr<Output>,
  AttributeDefinitionDiscardFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-discard',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeDefinitionDiscard');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeDefinitionDiscardDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeDefinitionDiscardFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-definition-discard',
      code: result.ok
        ? 'attribute' in result.value
          ? 'discarded'
          : 'proposed'
        : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeDefinitionDiscardFailure>> {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['attributeId', 'version', 'note']);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    const { deps } = this;
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(deps.review, context);
    try {
      return await deps.unitOfWork.run<ProposedOr<Output>, AttributeDefinitionDiscardFailure>(
        market,
        async () => {
          const found = await deps.attributeStore.findById(market, id);
          if (found === null) return err({ code: 'attribute.not-found' } as const);
          if (found.state.version !== version.value) {
            return err({ code: 'attribute.stale' } as const);
          }
          if (policy.reviewed) {
            const step = found.discard();
            if (!step.ok) return err(domainFailureOf(step.error));
            const proposed = await proposeCatalogueAction(deps.proposer, context, policy, {
              subjectKind: ATTRIBUTE_DISCARD_SUBJECT_KIND,
              subjectRef: id,
              before: attributeStateValues(found),
              after: attributeActionValues({ action: 'discard', version: version.value }),
              note: body.value['note'],
              tooLargePath: 'attributeId',
            });
            if (!proposed.ok) return err(proposed.error);
            const request = requestRef(proposed.value);
            if (request !== null) return ok({ request });
          }
          return discardAttributeInUnit(deps, context, found, null);
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}

/**
 * The discard inside the open unit, on the definition as read in it: the domain step, the
 * conditional status write and the audit row, naming the request whose approval or reject ran it
 * (null for an admin's own discard).
 */
export async function discardAttributeInUnit(
  deps: Pick<AttributeDefinitionStatusDependencies, 'attributeStore' | 'audit'>,
  context: CallContext,
  found: AttributeDefinition,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Output, AttributeDefinitionStatusFailure>> {
  const next = found.discard();
  if (!next.ok) return err(domainFailureOf(next.error));
  await deps.attributeStore.saveStatus(context.market, next.value);
  await deps.audit.record(
    context,
    AttributeDefinitionDiscardedAudit.entry(found.state.id, {
      before: { status: 'draft' },
      after: { status: 'archived', requestId },
    }),
  );
  return ok({ attribute: writeViewOf(next.value) });
}
