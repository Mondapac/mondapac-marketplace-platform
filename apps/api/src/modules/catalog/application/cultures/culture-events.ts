import type { CallContext, Clock, Id, IdGenerator } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { CultureStatus } from '../../domain/culture';
import {
  CultureApprovalsInvalidated,
  CultureCategoryMarkChanged,
  CultureStatusChanged,
} from '../../domain/events';

// The culture events of multi-culture package 3a (ADR-0047 decision 8; ADR-0048 security review
// N1). Written in the open read-write unit of the change; ids and a status only.

export interface CultureEventDependencies {
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** `catalog.culture-status-changed.v1` at the culture's version after the edit. */
export async function announceCultureStatus(
  deps: Pick<CultureEventDependencies, 'outbox' | 'clock'>,
  context: CallContext,
  culture: { readonly id: Id<'Culture'>; readonly status: CultureStatus; readonly version: number },
): Promise<void> {
  await deps.outbox.append(context, [
    CultureStatusChanged.record({
      aggregateId: culture.id,
      aggregateVersion: culture.version,
      occurredAt: deps.clock.now(),
      payload: { cultureId: culture.id, status: culture.status },
    }),
  ]);
}

/** `catalog.culture-category-mark-changed.v1`: a mark row has no version, so each event has its own id. */
export async function announceMarkChanged(
  deps: CultureEventDependencies,
  context: CallContext,
  cultureId: Id<'Culture'>,
  categoryId: Id<'Category'>,
): Promise<void> {
  await deps.outbox.append(context, [
    CultureCategoryMarkChanged.record({
      aggregateId: deps.ids.next(),
      aggregateVersion: 1,
      occurredAt: deps.clock.now(),
      payload: { cultureId, categoryId },
    }),
  ]);
}

/** `catalog.culture-approvals-invalidated.v1`: its own aggregate id at version 1. */
export async function announceApprovalsInvalidated(
  deps: CultureEventDependencies,
  context: CallContext,
  cultureId: Id<'Culture'>,
): Promise<void> {
  await deps.outbox.append(context, [
    CultureApprovalsInvalidated.record({
      aggregateId: deps.ids.next(),
      aggregateVersion: 1,
      occurredAt: deps.clock.now(),
      payload: { cultureId },
    }),
  ]);
}
