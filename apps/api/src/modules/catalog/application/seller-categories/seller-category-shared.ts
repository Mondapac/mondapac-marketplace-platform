import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  BLOCKED_TERM_CODE,
  type ContentFilter,
} from '../../../../platform/content-filter/content-filter';
import {
  parseCategoryTexts,
  type CategoryEditRefusal,
  type CategoryText,
} from '../../domain/category-edit';
import type { CategoryProposalView, ShelfText, ShelfView } from '../../domain/seller-category';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import { checkedPlaces, invalid, type CategoryWriteFailure } from '../categories/category-editor';
import type { ValidationFailure } from '../categories/category-admin-views';

export { invalid };
export type { ValidationFailure };

/** The ports every proposal and shelf command shares. */
export interface ShelfWriteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shelves: SellerCategoryStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The claim-text ports and the Market policy of a command that takes names. */
export interface ShelfTextDependencies {
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  /** The Market's blocked terms; a seller's shelf name or description may not hold one. */
  readonly contentFilter: ContentFilter;
}

/** The `normalised_name` column's length (characters). */
export const MAX_NORMALISED_NAME = 120;

/**
 * Reads a shelf, takes its seller's shelf lock, then reads it again under the lock, so a close
 * and an Offer moved onto the shelf run one after the other. Null when the shelf is unknown.
 */
export async function lockedShelf(
  shelves: SellerCategoryStore,
  market: MarketContext,
  id: Id<'SellerCategory'>,
): Promise<ShelfView | null> {
  const seen = await shelves.findShelf(market, id);
  if (seen === null) return null;
  await shelves.lockSeller(market, seen.sellerId);
  return shelves.findShelf(market, id);
}

/**
 * The shelf fields that hold a term of the Market's content filter (pure), as `validation.failed`
 * with the stable code `blocked-term`; the text itself never goes in the answer.
 */
export function blockedShelfFields(
  texts: readonly ShelfText[],
  isBlocked: (text: string) => boolean,
): Result<true, ValidationFailure> {
  const fields: { readonly path: string; readonly code: string }[] = [];
  for (const entry of texts) {
    if (isBlocked(entry.name))
      fields.push({ path: `texts.${entry.locale}.name`, code: BLOCKED_TERM_CODE });
    if (entry.description !== null && isBlocked(entry.description)) {
      fields.push({ path: `texts.${entry.locale}.shortDescription`, code: BLOCKED_TERM_CODE });
    }
  }
  return fields.length > 0 ? err({ code: 'validation.failed', fields }) : ok(true);
}

export type ClaimRefusal = Extract<
  CategoryWriteFailure,
  {
    readonly code:
      'claim-text.check-unavailable' | 'category.claim-word' | 'category.locale-uncheckable';
  }
>;

/** A proposal or shelf id from a route parameter; anything else is the not-found answer. */
export function proposalIdOf(raw: unknown): Id<'CategoryProposal'> | null {
  const parsed = typeof raw === 'string' ? parseId<'CategoryProposal'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

export function shelfIdOf(raw: unknown): Id<'SellerCategory'> | null {
  const parsed = typeof raw === 'string' ? parseId<'SellerCategory'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/**
 * The names of a proposal (pure): `{ [locale]: { name, shortDescription? } }`, the rules of a
 * platform category's texts (supported locales, the required ones named, plain text, lengths), but
 * no keywords: a shelf has none. The short description is the shelf's description.
 */
export function parseShelfTexts(
  raw: unknown,
  rules: { readonly supported: readonly string[]; readonly required: readonly string[] },
): Result<readonly ShelfText[], CategoryEditRefusal> {
  const texts = parseCategoryTexts(raw, rules);
  if (!texts.ok) return texts;
  const withKeywords = texts.value.find((text) => text.keywords.length > 0);
  if (withKeywords !== undefined) {
    return err({
      code: 'validation.failed',
      fields: [{ path: `texts.${withKeywords.locale}.keywords`, code: 'unknown' }],
    });
  }
  return ok(texts.value.map(shelfTextOf));
}

const shelfTextOf = (text: CategoryText): ShelfText => ({
  locale: text.locale,
  name: text.name,
  description: text.shortDescription,
});

/** A shelf text as a platform category text (promote): no keywords. */
export const categoryTextOf = (text: ShelfText): CategoryText => ({
  locale: text.locale,
  name: text.name,
  shortDescription: text.description,
  keywords: [],
});

/** The claim-checked places of shelf texts: each name and description in its own locale. */
export const shelfPlaces = (texts: readonly ShelfText[]): ReturnType<typeof checkedPlaces> =>
  checkedPlaces({ texts: texts.map(categoryTextOf) });

/** The name of the default locale, or the first one (the slug and the normalised name). */
export function defaultNameOf(texts: readonly ShelfText[], defaultLocale: string): string {
  return (texts.find((text) => text.locale === defaultLocale) ?? texts[0])?.name ?? '';
}

/** What a seller or an admin sees of a proposal. Names are the seller's own text. */
export interface ProposalBody {
  readonly id: string;
  readonly sellerId: string;
  readonly platformParentId: string;
  readonly texts: readonly ShelfText[];
  readonly status: string;
  readonly reasonCode: string | null;
  readonly sellerCategoryId: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

export const proposalBodyOf = (view: CategoryProposalView): ProposalBody => ({
  id: view.id,
  sellerId: view.sellerId,
  platformParentId: view.platformParentId,
  texts: view.texts,
  status: view.status,
  reasonCode: view.reasonCode,
  sellerCategoryId: view.createdSellerCategoryId,
  decidedAt: view.decidedAt?.toString() ?? null,
  createdAt: view.createdAt.toString(),
  version: view.version,
});

export interface ShelfBody {
  readonly id: string;
  readonly platformParentId: string;
  readonly slug: string;
  readonly status: string;
  readonly mergedIntoId: string | null;
  readonly texts: readonly ShelfText[];
  readonly version: number;
}

export const shelfBodyOf = (view: ShelfView): ShelfBody => ({
  id: view.id,
  platformParentId: view.platformParentId,
  slug: view.slug,
  status: view.status,
  mergedIntoId: view.mergedIntoId,
  texts: view.texts,
  version: view.version,
});

/** The live platform statuses a shelf may sit under, or be merged into. */
export const LIVE_PARENT = (status: string): boolean => status === 'active' || status === 'hidden';
