import type { CallContext } from '@mondapac/shared-kernel';

/** One filter of a listing as catalog defines it (attributes A7). */
export interface FilterDefinition {
  readonly code: string;
  readonly name: string;
  /** `choice` picks values, `range` reads a number between two bounds, `toggle` is only-yes. */
  readonly kind: 'choice' | 'range' | 'toggle';
  readonly options: readonly { readonly code: string; readonly label: string }[];
  /** A merged option's code and the option that now stands for it (read-time mapping). */
  readonly redirects: Readonly<Record<string, string>>;
}

/**
 * What catalog tells the listing about filters: the list of a category, or the global Brand and
 * Country of origin filters (their options are the brands and countries named). A failed read is
 * `null`: the listing then offers no filters and refuses a filtered request, never a wrong list.
 */
export interface SearchFilterSource {
  filters(
    context: CallContext,
    request: {
      readonly categoryId: string | null;
      readonly locale: string;
      readonly brandSlugs: readonly string[];
      readonly countryCodes: readonly string[];
    },
  ): Promise<readonly FilterDefinition[] | null>;
}

export const SEARCH_FILTER_SOURCE = Symbol('SEARCH_FILTER_SOURCE');
