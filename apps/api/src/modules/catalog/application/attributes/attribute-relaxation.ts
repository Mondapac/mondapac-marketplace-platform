import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AttributeRelaxationRequest } from '../../domain/attribute-relaxation-request';
import { AttributeRelaxationCancelledAudit } from '../../domain/audit';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRelaxationStore } from '../ports/attribute-relaxation.store';

/** What the relaxation use cases need (catalog design 8.2; attributes A2 part 3). */
export interface AttributeRelaxationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeStore: AttributeDefinitionStore;
  readonly relaxations: AttributeRelaxationStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A request id as given, or null when it is not one (answered as not found). */
export function requestIdOf(value: unknown): Id<'AttributeRelaxationRequest'> | null {
  const parsed = typeof value === 'string' ? parseId<'AttributeRelaxationRequest'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** The answer of a request write: its id, kind, status, version and times. */
export interface RelaxationWriteView {
  readonly id: string;
  readonly attributeId: string;
  readonly kind: string;
  readonly status: string;
  readonly version: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export function relaxationViewOf(request: AttributeRelaxationRequest): RelaxationWriteView {
  const state = request.state;
  return {
    id: state.id,
    attributeId: state.definitionId,
    kind: state.kind,
    status: state.status,
    version: state.version,
    requestedAt: state.requestedAt.toString(),
    expiresAt: state.expiresAt.toString(),
  };
}

/**
 * Q-K14: the unit that revised a definition cancels its open relaxation request, which named a
 * version that no longer exists. Runs in that unit after the revision (definition, then request:
 * the confirm unit's lock order). A request that another move closed first, before or during this
 * unit, is left as it is and the edit goes on.
 */
export async function cancelOpenRelaxation(
  deps: Pick<AttributeRelaxationDependencies, 'relaxations' | 'audit' | 'clock'>,
  context: CallContext,
  market: MarketContext,
  definitionId: Id<'AttributeDefinition'>,
): Promise<void> {
  const open = await deps.relaxations.openOf(market, definitionId);
  if (open === null) return;
  const cancelled = open.cancelForChange(deps.clock.now());
  if (!cancelled.ok) return;
  try {
    await deps.relaxations.saveMove(market, cancelled.value);
  } catch (error) {
    // Closed meanwhile by its requester or the expiry job (neither locks the definition): it can
    // no longer be confirmed, which is all this cancel is for, so the edit goes on.
    if (error instanceof StaleAggregateError) return;
    throw error;
  }
  await deps.audit.record(
    context,
    AttributeRelaxationCancelledAudit.entry(definitionId, {
      after: {
        requestId: open.state.id,
        reason: 'definition-changed',
        requestedByAccountId: open.state.requestedByAccountId,
      },
    }),
  );
}
