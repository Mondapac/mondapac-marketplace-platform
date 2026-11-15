import type { Result } from '@mondapac/shared-kernel';
import type { PermissionKey } from '../../../platform/authz';

// What a module registers to give one of its lists saved filters (super list phase 0, B0-1b). The
// module keeps the meaning of the payload and the keys that guard its list; `lists` keeps the
// table, the caps, the names and the sharing rules, and asks `AuthorisationCheck` for the two
// keys at run time. `lists` imports no module: a module provides its definitions to
// {@link LIST_DEFINITIONS} from its own Nest module.

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
  /** Reads the closed document of a request; returns it in its canonical form. */
  parsePayload(raw: unknown): Result<unknown, ListPayloadFailure>;
}

/** Nest token of the `readonly ListDefinition[]` a module provides (multi-provider by array). */
export const LIST_DEFINITIONS = Symbol('LIST_DEFINITIONS');
