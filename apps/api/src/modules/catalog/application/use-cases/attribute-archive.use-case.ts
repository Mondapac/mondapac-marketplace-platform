import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
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

export type AttributeArchiveFailure =
  | ValidationFailure
  | DomainFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' }
  /** Still in an active feature set, or a variant attribute with live variants. */
  | { readonly code: 'attribute.archive-blocked'; readonly fields: readonly FieldIssue[] }
  /** A `material` attribute is archived by a request and a second administrator. */
  | { readonly code: 'attribute.archive-needs-second-admin' }
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

type Output = { readonly attribute: AttributeWriteView };

export interface AttributeArchiveDependencies extends AttributeRestructureDependencies {
  /** The review policy of area catalogue (whether the archive waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the archive for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

/**
 * `attribute-definition.archive` (attributes A8): a published attribute is archived. Products
 * that carry its values keep them. Refused while an active feature set lists it
 * (`attribute.archive-blocked`, `fields[0].code` `in-feature-set`), for a variant attribute with live
 * variants (`live-variants`), and for a `material` attribute, which needs a request and a
 * second administrator (`attribute.archive-needs-second-admin`; see the archive request use
 * cases). Nothing is deleted (Q-K6). Rule: the key `catalog.attribute.restructure` (protected),
 * the admin population, never in an acting-as session. One unit that holds the attribute's row
 * while it reads the impact.
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): after the same checks the answer is the proposal (`request`, with a `note`) and
 * nothing is written. The approval runs {@link checkArchive} and {@link writeArchive} again
 * (catalogue-appliers.ts). The two-person archive of a `material` attribute is unchanged.
 */
export class AttributeArchive extends UseCase<
  { readonly [key: string]: unknown },
  ProposedOr<Output>,
  AttributeArchiveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-archive',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  readonly #logger = new Logger('AttributeArchive');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeArchiveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeArchiveFailure>> {
    const result = await this.#archive(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-archive',
      code: result.ok ? ('attribute' in result.value ? 'archived' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #archive(
    context: CallContext,
    input: { readonly [key: string]: unknown },
  ): Promise<Result<ProposedOr<Output>, AttributeArchiveFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
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
      return await deps.unitOfWork.run<ProposedOr<Output>, AttributeArchiveFailure>(
        market,
        async () => {
          const found = await deps.attributeStore.findById(market, id);
          if (found === null) return err({ code: 'attribute.not-found' } as const);
          if (found.state.version !== version.value) {
            return err({ code: 'attribute.stale' } as const);
          }
          const checked = await checkArchive(deps, market, found);
          if (!checked.ok) return checked;
          if (policy.reviewed) {
            const proposed = await proposeCatalogueAction(deps.proposer, context, policy, {
              subjectKind: ATTRIBUTE_RESTRUCTURE_SUBJECT_KIND,
              subjectRef: id,
              before: attributeStateValues(found),
              after: attributeActionValues({ action: 'archive', version: version.value }),
              note: body.value['note'],
              tooLargePath: 'attributeId',
            });
            if (!proposed.ok) return err(proposed.error);
            const request = requestRef(proposed.value);
            if (request !== null) return ok({ request });
          }
          return writeArchive(deps, context, found, null);
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}

/**
 * The checks of a (non-material) archive inside the open unit, holding the attribute's row at the
 * version read: archivable, not `material`, not in an active feature set, no live variants, no
 * attribute merged into it. Shared by the route and by the approval of a proposed archive.
 */
export async function checkArchive(
  deps: Pick<AttributeRestructureDependencies, 'attributeStore' | 'impact'>,
  market: MarketContext,
  found: AttributeDefinition,
): Promise<Result<null, AttributeArchiveFailure>> {
  const problem = found.archivable();
  if (problem !== null) return err(domainFailureOf(problem));
  if (found.state.material) return err({ code: 'attribute.archive-needs-second-admin' });
  if (!(await deps.attributeStore.lockAtVersion(market, found.state.id, found.state.version))) {
    return err({ code: 'attribute.stale' });
  }
  const impact = await deps.impact.impactOf(market, {
    code: found.state.code,
    isVariantOption: found.state.isVariantOption,
  });
  const block = await archiveBlockWithMergesOf(deps, market, found, impact);
  if (block !== null) {
    return err({ code: 'attribute.archive-blocked', fields: [{ path: 'attribute', code: block }] });
  }
  return ok(null);
}

/** The archive after {@link checkArchive}: the status, the audit row and the open relaxation. */
export async function writeArchive(
  deps: AttributeRestructureDependencies,
  context: CallContext,
  found: AttributeDefinition,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Output, AttributeArchiveFailure>> {
  const { market } = context;
  const next = found.archive();
  if (!next.ok) return err(domainFailureOf(next.error));
  await deps.attributeStore.saveStatus(market, next.value);
  await deps.audit.record(
    context,
    AttributeDefinitionArchivedAudit.entry(found.state.id, {
      before: { status: 'active', material: false },
      after: {
        status: 'archived',
        relaxationRequestId: null,
        requestedByAccountId: null,
        requestId,
      },
    }),
  );
  await cancelOpenRelaxation(deps, context, market, found.state.id);
  return ok({ attribute: writeViewOf(next.value) });
}
