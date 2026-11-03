import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isActingAsSession } from '../acting-as';
import {
  CATEGORY_CASCADE_MAX,
  SEARCH_TEXT_LOCALE,
  type CategoryEditRefusal,
  type CategorySeo,
  type CategoryText,
  type EditableCategory,
  type FieldIssue,
} from '../../domain/category-edit';
import { PlatformCategoryChanged } from '../../domain/events';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryEditStore } from '../ports/category-edit.store';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import { MAX_MATCH_TEXTS, type ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import {
  categoryIdOf,
  closedInput,
  invalid,
  requiredCategoryLocales,
  type ValidationFailure,
} from './category-admin-views';

export { categoryIdOf, closedInput, invalid, requiredCategoryLocales };

export type CategoryWriteFailure =
  | CategoryEditRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim-text.check-unavailable' }
  | { readonly code: 'category.claim-word'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'category.locale-uncheckable'; readonly fields: readonly FieldIssue[] }
  | ValidationFailure;

export interface CategoryWriteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: CategoryEditStore;
  readonly categories: PlatformCategoryRepository;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What a write answers: enough for the page to re-read the category and keep its versions. */
export interface CategoryWriteView {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
  readonly version: number;
  readonly revisionNo: number;
  /** `category_trees.version` after the write (what the next structural change must name). */
  readonly treeVersion: number;
}

/**
 * The admin account of an authenticated admin who is not in an acting-as session (plan section
 * 11: no tree edit from a Login as Seller session), or null.
 */
export function editorAccountOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  if (isActingAsSession(actor)) return null;
  return actor.accountId;
}

export function versionOf(raw: unknown, path: string): Result<number, ValidationFailure> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return invalid(path, 'type');
  }
  return ok(raw);
}

/** One text to claim-check with the path the page puts the error at. */
interface CheckedPlace {
  readonly path: string;
  readonly locale: string;
  readonly text: string;
}

/**
 * Every name, short description and keyword in every filled locale, the search-result fields and
 * the slug (plan section 8a; catalog design 6.2). Search-result fields and the slug are English,
 * so they are checked with the English vocabulary whatever the Market's default locale is.
 */
export function checkedPlaces(input: {
  readonly texts?: readonly CategoryText[];
  readonly seo?: CategorySeo;
  readonly slug?: string;
}): readonly CheckedPlace[] {
  const places: CheckedPlace[] = [];
  for (const text of input.texts ?? []) {
    places.push({ path: `texts.${text.locale}.name`, locale: text.locale, text: text.name });
    if (text.shortDescription !== null) {
      places.push({
        path: `texts.${text.locale}.shortDescription`,
        locale: text.locale,
        text: text.shortDescription,
      });
    }
    text.keywords.forEach((keyword, index) => {
      places.push({
        path: `texts.${text.locale}.keywords.${index}`,
        locale: text.locale,
        text: keyword,
      });
    });
  }
  if (input.seo?.title) {
    places.push({ path: 'seo.title', locale: SEARCH_TEXT_LOCALE, text: input.seo.title });
  }
  if (input.seo?.description) {
    places.push({
      path: 'seo.description',
      locale: SEARCH_TEXT_LOCALE,
      text: input.seo.description,
    });
  }
  if (input.slug !== undefined) {
    places.push({ path: 'slug', locale: SEARCH_TEXT_LOCALE, text: input.slug });
  }
  return places;
}

/**
 * The claim-text check of a category write (catalog design 6.3; plan section 8a), failing closed:
 * a locale the vocabulary does not cover is `category.locale-uncheckable`, an unreadable
 * vocabulary or matcher is `claim-text.check-unavailable`, a hit is `category.claim-word` with
 * the paths and never the words. Call it with no unit of work open: the certification facade
 * opens its own.
 */
export async function refuseClaimTexts(
  deps: Pick<CategoryWriteDependencies, 'matcher' | 'claimLocales'>,
  context: CallContext,
  places: readonly CheckedPlace[],
): Promise<CategoryWriteFailure | null> {
  if (places.length === 0) return null;
  const covered = await deps.claimLocales.covered(context);
  if (!covered.ok) return { code: 'claim-text.check-unavailable' };
  const uncheckable = places
    .filter((place) => !covered.value.includes(place.locale))
    .map((place) => ({ path: place.path, code: 'locale-uncheckable' }));
  if (uncheckable.length > 0) return { code: 'category.locale-uncheckable', fields: uncheckable };
  const found: FieldIssue[] = [];
  for (let from = 0; from < places.length; from += MAX_MATCH_TEXTS) {
    const batch = places.slice(from, from + MAX_MATCH_TEXTS);
    let answer: Awaited<ReturnType<ClaimTextMatcher['match']>>;
    try {
      answer = await deps.matcher.match(
        context,
        batch.map(({ locale, text }) => ({ locale, text })),
      );
    } catch {
      return { code: 'claim-text.check-unavailable' };
    }
    if (!answer.ok || !Array.isArray(answer.value) || answer.value.length !== batch.length) {
      return { code: 'claim-text.check-unavailable' };
    }
    for (const [index, place] of batch.entries()) {
      const hits: unknown = answer.value[index];
      if (!Array.isArray(hits)) return { code: 'claim-text.check-unavailable' };
      if (hits.length > 0) found.push({ path: place.path, code: 'claim-word' });
    }
  }
  return found.length > 0 ? { code: 'category.claim-word', fields: found } : null;
}

export interface TreeGuarded<T> {
  readonly value: T;
}

/**
 * Runs one structural write (plan section 3: every structural write raises the tree version with
 * a guarded update). Inside one unit: the tree version the page named must be the stored one, it
 * is raised first (the row lock serialises two admins; the loser is `conflict.stale`), then
 * `work` reads the whole tree and writes. Any `StaleAggregateError` is `conflict.stale`.
 */
export async function runStructural<T>(
  deps: CategoryWriteDependencies,
  market: MarketContext,
  expectedTreeVersion: number,
  work: (
    nodes: readonly EditableCategory[],
    treeVersion: number,
  ) => Promise<Result<T, CategoryWriteFailure>>,
): Promise<Result<T, CategoryWriteFailure>> {
  try {
    return await deps.unitOfWork.run<T, CategoryWriteFailure>(market, async () => {
      const tree = await deps.categories.treeVersion(market);
      if (tree.version !== expectedTreeVersion) return err({ code: 'conflict.stale' } as const);
      await deps.categories.bumpTreeVersion(market, tree.version);
      const nodes = await deps.store.loadAll(market, MAX_TREE_NODES + 1);
      if (nodes.length > MAX_TREE_NODES) return err({ code: 'access.unavailable' } as const);
      return work(nodes, tree.version + 1);
    });
  } catch (error) {
    if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
    throw error;
  }
}

/** Announces `catalog.platform-category-changed.v1` for one category at its new version. */
export async function announceChanged(
  deps: Pick<CategoryWriteDependencies, 'outbox' | 'clock'>,
  context: CallContext,
  id: Id<'Category'>,
  version: number,
): Promise<void> {
  await deps.outbox.append(context, [
    PlatformCategoryChanged.record({
      aggregateId: id,
      aggregateVersion: version,
      occurredAt: deps.clock.now(),
      payload: { categoryId: id },
    }),
  ]);
}

export const CASCADE_MAX = CATEGORY_CASCADE_MAX;
