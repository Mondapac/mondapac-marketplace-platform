import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** A live platform category, as the buyer site's menu shows it. */
export interface AssistantCategory {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly name: string;
  readonly depth: number;
}

/**
 * The READ tool `catalog` publishes for the buyer assistant (ADR-0019 decision 6, R3): the public
 * category tree, through the storefront's own use case (rule `anonymous`) with the caller's
 * `CallContext` unchanged.
 */
export interface CatalogAssistantFacade {
  categories(
    context: CallContext,
  ): Promise<
    Result<readonly AssistantCategory[], { readonly code: 'catalog.categories-unavailable' }>
  >;
}

export const CATALOG_ASSISTANT_FACADE = Symbol('CATALOG_ASSISTANT_FACADE');
