import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { SAVED_FILTER_AUDIT_LISTS, type SavedFilterAuditList } from '../../domain/audit';
import type { SavedFilter } from '../../domain/saved-filter';
import {
  mayManage,
  parseSavedFilterName,
  SAVED_FILTER_VISIBILITIES,
} from '../../domain/saved-filter';
import type { SavedFilterVisibility } from '../../domain/saved-filter';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { AccessProbe } from '../use-cases/saved-filter-share-check.use-case';
import { savedFilterListOf, type SavedFilterListDefinition } from './saved-filter-lists';

// What the saved-filter use cases share: the admin of the call, the closed pieces of a request and
// the answer of one filter. Use cases cannot extend one another, so plain functions live here.

/** The admin the call acts for; the population is checked here, the key by the gate. */
export function adminOf(context: CallContext): { readonly accountId: Id<'Account'> } | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  return { accountId: actor.accountId };
}

export function listOf(
  value: unknown,
  path = 'listKey',
): Result<SavedFilterListDefinition, ValidationFailure> {
  if (value === undefined || value === null || value === '') return invalid(path, 'required');
  const list = savedFilterListOf(value);
  return list === null ? invalid(path, 'value') : ok(list);
}

export function nameOf(value: unknown): Result<string, ValidationFailure> {
  const name = parseSavedFilterName(value);
  return name.ok ? ok(name.value) : invalid('name', name.error);
}

export function visibilityOf(value: unknown): Result<SavedFilterVisibility, ValidationFailure> {
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

/**
 * Whether the caller holds the share key, asked through the probe use case (its own gate reads
 * the account's role). `access.denied` is a plain "no"; any other refusal is the gate not being
 * able to say, which the caller answers as `access.unavailable`. Asked before a unit opens: the
 * gate reads in a unit of its own.
 */
export async function canShareOf(
  probe: AccessProbe,
  context: CallContext,
): Promise<Result<boolean, { readonly code: 'access.unavailable' }>> {
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
  /** The products it matches now; null when the list does not count or the count was skipped. */
  readonly count: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function viewOf(
  filter: SavedFilter,
  actorAccountId: Id<'Account'>,
  canShare: boolean,
  count: number | null,
): SavedFilterView {
  const ownedByMe = filter.ownerAccountId === actorAccountId;
  return {
    id: filter.id,
    listKey: filter.listKey,
    name: filter.name,
    visibility: filter.visibility,
    payload: filter.payload,
    ownedByMe,
    canManage: mayManage(filter, actorAccountId, canShare),
    count,
    createdAt: filter.createdAt.toString(),
    updatedAt: filter.updatedAt.toString(),
  };
}

/**
 * The audit vocabulary's code of a list key. Every registered list is in it (a test checks), so
 * the fallback is never taken; it keeps an unlisted key out of the audit row rather than failing
 * the user's action after the write.
 */
export function auditListOf(listKey: string): SavedFilterAuditList {
  return SAVED_FILTER_AUDIT_LISTS.find((known) => known === listKey) ?? SAVED_FILTER_AUDIT_LISTS[0];
}
