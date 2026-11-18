import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { AuthorisationCheck } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { ColumnPreferenceStore, ListPopulation } from '../contracts';
import {
  invalid,
  type AccessRefusal,
  type ListRegistry,
  type ValidationFailure,
} from './saved-filter-shared';

// What the column-preference use cases share (super list B0-2): their failures, ports, answer and
// the two checks of a request: a closed body, and a list that has a column choice.

export type ColumnPreferenceFailure = AccessRefusal | ValidationFailure;

export interface ColumnPreferenceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: ColumnPreferenceStore;
  readonly registry: ListRegistry;
  readonly authorisation: AuthorisationCheck;
}

export interface ColumnPreferenceView {
  readonly listKey: string;
  /** The saved ids in order; null when the user never chose (the panel shows the default). */
  readonly columns: readonly string[] | null;
  /** The ids the list lets a user choose from, in the list's own order. */
  readonly available: readonly string[];
}

export function bodyOf(
  input: unknown,
  keys: ReadonlySet<string>,
): Result<Record<string, unknown>, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('body', 'type');
  }
  for (const key of Object.keys(input)) if (!keys.has(key)) return invalid(key, 'unknown');
  return ok(input as Record<string, unknown>);
}

/** The list a request names, when it has a column choice at all. */
export function columnListOf(registry: ListRegistry, value: unknown, population: ListPopulation) {
  const list = registry.lookup(value, population);
  if (!list.ok) return list;
  if (list.value.columns === undefined) return invalid('listKey', 'value');
  return ok({ definition: list.value, available: list.value.columns });
}
