import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AuthorisationCheck } from '../../../platform/authz';
import type { ListDefinition, ListPayloadFailure, StoredFilter } from '../contracts';
import {
  mayManage,
  parseSavedFilterName,
  SAVED_FILTER_VISIBILITIES,
  type StoredFilterVisibility,
} from '../domain/saved-filter-rules';
import { LISTS_AUDIT_LIST_KEYS, type ListsAuditListKey } from '../domain/audit';

// What the generic saved-filter use cases share: the caller, the list a request names, the two
// permission checks and the answer of one filter. Use cases cannot extend one another, so plain
// functions live here.

export type ValidationFailure = ListPayloadFailure;

export const invalid = (path: string, code: string): Result<never, ValidationFailure> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

/** The account of an admin call; null for anything else (the use case answers access.denied). */
export function adminOf(context: CallContext): { readonly accountId: Id<'Account'> } | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  return { accountId: actor.accountId };
}

/**
 * The lists that have saved filters, filled at boot by each module's `registerLists`. Reads are
 * by list key; a key that is no list of the population is a validation failure, never a hint
 * about another population's lists.
 */
export class ListRegistry {
  readonly #byKey = new Map<string, ListDefinition>();

  register(owner: string, definitions: readonly ListDefinition[]): void {
    for (const definition of definitions) {
      if (this.#byKey.has(definition.listKey)) {
        throw new Error(`list ${definition.listKey} is registered twice (${owner})`);
      }
      if (!definition.listKey.startsWith(`${definition.population}.${owner}.`)) {
        throw new Error(
          `list ${definition.listKey} must start with ${definition.population}.${owner}.`,
        );
      }
      if (!(LISTS_AUDIT_LIST_KEYS as readonly string[]).includes(definition.listKey)) {
        throw new Error(`list ${definition.listKey} is missing from the lists audit vocabulary`);
      }
      this.#byKey.set(definition.listKey, definition);
    }
  }

  /** The list a request names, or a `validation.failed` for a key that is no list of the population. */
  lookup(
    value: unknown,
    population: ListDefinition['population'],
    path = 'listKey',
  ): Result<ListDefinition, ValidationFailure> {
    if (value === undefined || value === null || value === '') return invalid(path, 'required');
    if (typeof value !== 'string') return invalid(path, 'type');
    const found = this.#byKey.get(value);
    return found === undefined || found.population !== population
      ? invalid(path, 'value')
      : ok(found);
  }
}

export type AccessRefusal =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

/**
 * Asks the gate whether the caller holds one key of a list. A plain "no" is `access.denied`; a
 * gate that could not say (an unavailable dependency) is `access.unavailable`: both refuse, so the
 * check fails closed. Asked before a unit opens: the check reads in a unit of its own.
 */
export async function holds(
  authorisation: AuthorisationCheck,
  context: CallContext,
  useCase: string,
  key: ListDefinition['viewKey'],
): Promise<Result<true, AccessRefusal>> {
  const decision = await authorisation.check(context, {
    name: useCase,
    rule: { kind: 'permissions', allOf: [key] },
  });
  if (decision.allowed) return ok(true);
  return decision.denial.code === 'access.denied'
    ? err({ code: 'access.denied' })
    : err({ code: 'access.unavailable' });
}

/** Whether the caller holds the list's share key; unavailable is an error, not a "no". */
export async function canShareOf(
  authorisation: AuthorisationCheck,
  context: CallContext,
  useCase: string,
  list: ListDefinition,
): Promise<Result<boolean, { readonly code: 'access.unavailable' }>> {
  const answer = await holds(authorisation, context, `${useCase}-share`, list.shareKey);
  if (answer.ok) return ok(true);
  return answer.error.code === 'access.denied' ? ok(false) : err({ code: 'access.unavailable' });
}

export function nameOf(value: unknown): Result<string, ValidationFailure> {
  const name = parseSavedFilterName(value);
  return name.ok ? ok(name.value) : invalid('name', name.error);
}

export function visibilityOf(value: unknown): Result<StoredFilterVisibility, ValidationFailure> {
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

/** A filter as the API answers it. */
export interface SavedFilterView {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: StoredFilterVisibility;
  readonly payload: unknown;
  readonly ownedByMe: boolean;
  /** Whether the caller may rename, change the visibility of or delete it. */
  readonly canManage: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function viewOf(
  filter: StoredFilter,
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
    position: filter.position,
    createdAt: filter.createdAt.toString(),
    updatedAt: filter.updatedAt.toString(),
  };
}

/** The audit code of a list key; the registry refuses a key that is not in the vocabulary. */
export const auditListOf = (listKey: string): ListsAuditListKey =>
  LISTS_AUDIT_LIST_KEYS.find((known) => known === listKey) ?? LISTS_AUDIT_LIST_KEYS[0];
