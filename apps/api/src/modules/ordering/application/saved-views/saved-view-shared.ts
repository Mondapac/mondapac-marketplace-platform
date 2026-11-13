import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SAVED_FILTER_AUDIT_LISTS, type SavedFilterAuditList } from '../../domain/audit';
import {
  mayManage,
  parseSavedFilterName,
  SAVED_FILTER_VISIBILITIES,
  type SavedFilter,
  type SavedFilterVisibility,
} from '../../domain/saved-view';
import type { SavedFilterRepository } from '../ports/saved-filter.repository';
import {
  invalid,
  savedFilterListOf,
  type SavedFilterListDefinition,
  type ValidationFailure,
} from './saved-view-lists';

// What the saved-filter use cases share: the account of the call, the closed
// pieces of a request and the answer of one filter. Use cases cannot extend one another, so plain
// functions live here.

export type Population = 'admin' | 'seller';

/** The account the call acts for in the given population; the key is checked by the gate. */
export function callerOf(
  context: CallContext,
  population: Population,
): { readonly accountId: Id<'Account'> } | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== population) return null;
  return { accountId: actor.accountId };
}

/** The list a request names, and only if the population of the call uses it. */
export function listOf(
  value: unknown,
  population: Population,
  path = 'listKey',
): Result<SavedFilterListDefinition, ValidationFailure> {
  if (value === undefined || value === null || value === '') return invalid(path, 'required');
  const list = savedFilterListOf(value);
  return list === null || list.population !== population ? invalid(path, 'value') : ok(list);
}

export function nameOf(value: unknown): Result<string, ValidationFailure> {
  const name = parseSavedFilterName(value);
  return name.ok ? ok(name.value) : invalid('name', name.error);
}

/**
 * The visibility of a request. A list that cannot be shared is always `me`: it may be left out and
 * `everyone` is refused as a value error.
 */
export function visibilityOf(
  value: unknown,
  list: SavedFilterListDefinition,
): Result<SavedFilterVisibility, ValidationFailure> {
  if (!list.shareable) {
    if (value === undefined || value === null || value === 'me') return ok('me');
    return invalid('visibility', 'value');
  }
  if (value === undefined || value === null) return invalid('visibility', 'required');
  const found = SAVED_FILTER_VISIBILITIES.find((candidate) => candidate === value);
  return found === undefined ? invalid('visibility', 'value') : ok(found);
}

/** A filter id from a request: any text that is not an id is the same `saved-filter.not-found`. */
export function filterIdOf(value: unknown): Id<'SavedFilter'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'SavedFilter'>(value);
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** What the use cases need of the share probe: its `execute` and nothing else. */
export interface AccessProbe {
  execute(
    context: CallContext,
    input: Record<string, never>,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } }
  >;
}

/**
 * Whether the caller holds the share key, asked through the probe use case (its own gate reads
 * the account's role). `access.denied` is a plain "no"; any other refusal is the gate not being
 * able to say, which the caller answers as `access.unavailable`. A list that cannot be shared
 * never asks. Asked before a unit opens: the gate reads in a unit of its own.
 */
export async function canShareOf(
  probe: AccessProbe | null,
  context: CallContext,
): Promise<Result<boolean, { readonly code: 'access.unavailable' }>> {
  if (probe === null) return ok(false);
  const answer = await probe.execute(context, {});
  if (answer.ok) return ok(true);
  return answer.error.code === 'access.denied' ? ok(false) : err({ code: 'access.unavailable' });
}

/** A filter as the API answers it. */
export interface SavedFilterView {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: SavedFilterVisibility;
  readonly payload: unknown;
  /** True for the caller's own filter. */
  readonly ownedByMe: boolean;
  /** Whether the caller may rename, change the visibility of or delete it. */
  readonly canManage: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function viewOf(
  filter: SavedFilter,
  actorAccountId: Id<'Account'>,
  canShare: boolean,
): SavedFilterView {
  return {
    id: filter.id,
    listKey: filter.listKey,
    name: filter.name,
    visibility: filter.visibility,
    payload: filter.payload,
    ownedByMe: filter.ownerAccountId === actorAccountId,
    canManage: mayManage(filter, actorAccountId, canShare),
    createdAt: filter.createdAt.toString(),
    updatedAt: filter.updatedAt.toString(),
  };
}

/**
 * The audit vocabulary's code of a list key. Only shareable lists are audited (a seller filter is
 * never shared), so the fallback is never taken; it keeps an unlisted key out of the audit row
 * rather than failing the user's action after the write.
 */
export function auditListOf(listKey: string): SavedFilterAuditList {
  return SAVED_FILTER_AUDIT_LISTS.find((known) => known === listKey) ?? SAVED_FILTER_AUDIT_LISTS[0];
}

export interface SavedViewDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly savedFilters: SavedFilterRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The share probe of the admin use cases; null for the seller ones (nothing is shared). */
  readonly shareCheck: AccessProbe | null;
}
