import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AuthorisationCheck } from '../../../platform/authz';
import { MAX_PREFERRED_COLUMNS } from '../contracts';
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

/** Who calls a generic list route: the account and, for a seller, the store of the session. */
export interface ListCaller {
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'> | null;
}

/**
 * The caller of a route of `population`. Any other population is `access.denied`. A seller who
 * acts as the store for another person (Login as Seller) is refused: a saved view is the seller's
 * own preference, and the AI rules forbid acting-as as well. The reserved `actingAs` marker is read
 * from the actor as catalog reads it, without importing a module.
 */
export function callerOf(
  context: CallContext,
  population: ListDefinition['population'],
): Result<ListCaller, AccessRefusal> {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== population) {
    return err({ code: 'access.denied' });
  }
  if (population === 'admin') return ok({ accountId: actor.accountId, sellerId: null });
  if (actor.sellerId === null) return err({ code: 'access.denied' });
  if (Object.hasOwn(actor, 'actingAs')) {
    const marker = (actor as { readonly actingAs?: unknown }).actingAs;
    if (marker !== null && marker !== undefined) return err({ code: 'access.acting-as-refused' });
  }
  return ok({ accountId: actor.accountId, sellerId: actor.sellerId });
}

/**
 * The store a list's rows are kept under: the caller's store for a store-scoped seller list, none
 * for an admin list or an account-scoped one (the rows belong to the account in every store).
 */
export function storeOf(caller: ListCaller, list: ListDefinition): Id<'Seller'> | null {
  return list.population === 'seller' && list.scope !== 'account' ? caller.sellerId : null;
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
      const columns = definition.columns;
      if (
        columns !== undefined &&
        (new Set(columns).size !== columns.length ||
          columns.length > MAX_PREFERRED_COLUMNS ||
          Buffer.byteLength(JSON.stringify(columns)) > 1024)
      ) {
        throw new Error(`list ${definition.listKey} has an invalid column vocabulary`);
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

const ACCESS_LOG = new Logger('ListsAccess');

export type AccessRefusal =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.acting-as-refused' };

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
  let decision: Awaited<ReturnType<AuthorisationCheck['check']>>;
  try {
    decision = await authorisation.check(context, {
      name: useCase,
      rule: { kind: 'permissions', allOf: [key] },
    });
  } catch {
    // The port could not answer: refuse, as a gate does.
    decision = { allowed: false, denial: { code: 'access.unavailable' } };
  }
  if (decision.allowed) return ok(true);
  // The gate admits every active admin of an own-resources rule, so the real refusals are here.
  ACCESS_LOG.warn({
    msg: 'lists.access-refused',
    useCase,
    key,
    code: decision.denial.code,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
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
  // A list with no share key cannot be shared with everyone, whoever asks.
  if (list.shareKey === undefined) return ok(false);
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
export const auditListOf = (listKey: string): ListsAuditListKey => {
  const known = LISTS_AUDIT_LIST_KEYS.find((key) => key === listKey);
  if (known === undefined) throw new Error(`lists: ${listKey} is not in the audit vocabulary`);
  return known;
};
