import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import { PlatformCategoryCreated } from './events';

export const CATEGORY_STATUSES = ['active', 'merged', 'archived'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

/** Who made a change: the deploy-time seed or an admin (data design 3.4). */
export const CATEGORY_AUTHOR_KINDS = ['seed', 'admin'] as const;
export type CategoryAuthorKind = (typeof CATEGORY_AUTHOR_KINDS)[number];

/** The depth at which the database refuses a node (data design 3.4; Ali, Q-K8). */
export const MAX_CATEGORY_DEPTH = 64;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
const VERTICAL_ROOT_CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const NAME_MAX = 120;

/** One name in one locale. */
export interface CategoryName {
  readonly locale: string;
  readonly name: string;
}

export interface PlatformCategoryState {
  readonly id: Id<'Category'>;
  readonly marketId: MarketId;
  /** Null for a root. */
  readonly parentId: Id<'Category'> | null;
  readonly verticalRootCode: string | null;
  readonly slug: string;
  readonly status: CategoryStatus;
  readonly createdByKind: CategoryAuthorKind;
  /** The id of the revision this root points at (revision 1 at creation). */
  readonly revisionId: Id<'CategoryRevision'>;
  readonly revisionNo: number;
  readonly names: readonly CategoryName[];
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** Why a category was refused: a stable code, never the text. */
export type CategoryRefusal =
  | { readonly code: 'category.slug-invalid' }
  | { readonly code: 'category.name-required' }
  | { readonly code: 'category.name-invalid'; readonly locale: string }
  | { readonly code: 'category.locale-invalid' }
  | { readonly code: 'category.locale-repeated' }
  | { readonly code: 'category.vertical-root-needs-root' }
  | { readonly code: 'category.vertical-root-code-invalid' };

/**
 * A node of the platform category tree (catalog design 2.1, 4.6). This slice holds creation and
 * the first revision (name per locale, parent); the editor's rename, move, merge and archive
 * arrive with slice 21. The seed only ever creates (Ali B4).
 */
export class PlatformCategory {
  readonly #state: PlatformCategoryState;
  readonly #events: PendingEvent[];

  private constructor(state: PlatformCategoryState, events: PendingEvent[]) {
    this.#state = Object.freeze(state);
    this.#events = events;
  }

  /** A new active category with revision 1, announcing `catalog.platform-category-created.v1`. */
  static create(input: {
    readonly id: Id<'Category'>;
    readonly revisionId: Id<'CategoryRevision'>;
    readonly marketId: MarketId;
    readonly parentId: Id<'Category'> | null;
    readonly verticalRootCode: string | null;
    readonly slug: string;
    readonly names: readonly CategoryName[];
    readonly createdByKind: CategoryAuthorKind;
    readonly now: Temporal.Instant;
  }): Result<PlatformCategory, CategoryRefusal> {
    if (!SLUG.test(input.slug) || input.slug.length < 2 || input.slug.length > 80) {
      return err({ code: 'category.slug-invalid' });
    }
    if (input.verticalRootCode !== null) {
      if (input.parentId !== null) return err({ code: 'category.vertical-root-needs-root' });
      if (!VERTICAL_ROOT_CODE.test(input.verticalRootCode)) {
        return err({ code: 'category.vertical-root-code-invalid' });
      }
    }
    if (input.names.length === 0) return err({ code: 'category.name-required' });
    const seen = new Set<string>();
    for (const entry of input.names) {
      if (!LOCALE.test(entry.locale)) return err({ code: 'category.locale-invalid' });
      if (seen.has(entry.locale)) return err({ code: 'category.locale-repeated' });
      seen.add(entry.locale);
      const trimmed = entry.name === entry.name.trim();
      const length = [...entry.name].length;
      if (!trimmed || length < 1 || length > NAME_MAX || !parsePlainText(entry.name).ok) {
        return err({ code: 'category.name-invalid', locale: entry.locale });
      }
    }
    const state: PlatformCategoryState = {
      id: input.id,
      marketId: input.marketId,
      parentId: input.parentId,
      verticalRootCode: input.verticalRootCode,
      slug: input.slug,
      status: 'active',
      createdByKind: input.createdByKind,
      revisionId: input.revisionId,
      revisionNo: 1,
      names: input.names,
      version: 1,
      createdAt: input.now,
    };
    const event = PlatformCategoryCreated.record({
      aggregateId: input.id,
      aggregateVersion: 1,
      occurredAt: input.now,
      payload: { categoryId: input.id },
    });
    return ok(new PlatformCategory(state, [event]));
  }

  get state(): PlatformCategoryState {
    return this.#state;
  }

  /** Events recorded since the category was built, in version order. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }
}
