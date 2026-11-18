import type { Provider } from '@nestjs/common';
import type { Result } from '@mondapac/shared-kernel';
import type { PermissionKey } from '../../../platform/authz';

// What a module registers to give one of its lists saved filters (super list phase 0, B0-1b). The
// module keeps the meaning of the payload and the keys that guard its list; `lists` keeps the
// table, the caps, the names and the sharing rules, and asks `AuthorisationCheck` for the two
// keys at run time. `lists` imports no module: a module provides its definitions to
// the registry from its own Nest module.

/** The panel a list belongs to; its routes read that panel's session. */
export type ListPopulation = 'admin' | 'seller';

/** A field the payload parser refuses, as the API answers it (`details.fields`). */
export interface ListPayloadFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export interface ListDefinition {
  /** `admin.<module>.<list>` or `seller.<module>.<list>`; the first segment is the population. */
  readonly listKey: string;
  readonly population: ListPopulation;
  /** The key that lets the caller see the list, hence its saved filters. */
  readonly viewKey: PermissionKey;
  /** The key that lets the caller share a filter with everyone or manage a shared one. */
  readonly shareKey: PermissionKey;
  /**
   * The ids of the columns a user may show, hide and reorder in this list (the ones after the
   * columns that are always shown). Absent: the list has no column choice and refuses one.
   */
  readonly columns?: readonly string[];
  /** Reads the closed document of a request; returns it in its canonical form. */
  parsePayload(raw: unknown): Result<unknown, ListPayloadFailure>;
}

/** What a module sees of the registry of lists: it registers its own and nothing else. */
export interface ListRegistration {
  register(owner: string, definitions: readonly ListDefinition[]): void;
}

/** Nest token of the {@link ListRegistration}, exported by `ListsModule`. */
export const LIST_REGISTRATION = Symbol('LIST_REGISTRATION');

/**
 * The one line of a module's Nest module that registers its lists at bootstrap:
 * `providers: [registerLists('catalog', CATALOG_LISTS)]`, with `ListsModule` imported. A list key is
 * `<population>.<owner>.<list>`; it is also added to the lists audit vocabulary.
 */
export function registerLists(owner: string, definitions: readonly ListDefinition[]): Provider {
  return {
    provide: Symbol(`lists:${owner}`),
    inject: [LIST_REGISTRATION],
    useFactory: (registration: ListRegistration) => {
      registration.register(owner, definitions);
      return owner;
    },
  };
}
