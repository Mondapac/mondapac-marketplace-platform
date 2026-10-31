import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// The brand entity (catalog brand package). A brand is shared by every Market: it carries no
// `market_id` (see the schema comment on CatalogBrand), so nothing here depends on a Market.
//
//   draft ---approve---> active ---archive---> archived
//     |                                           ^
//     +-------------------archive-----------------+      (a merge archives its source too)
//
// A seller's proposal is born `draft` and invisible until an admin approves it; an admin creates
// an `active` brand straight away. An archived brand is final: it keeps its row, its slug and its
// aliases, so a link to it never points at another brand.

export const BRAND_STATUSES = ['draft', 'active', 'archived'] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export const BRAND_NAME_MAX = 120;
export const BRAND_SLUG_MAX = 80;
/** A generated slug leaves room for a numeric suffix (`-2`, `-10`, ...). */
export const BRAND_SLUG_BASE_MAX = 70;
export const BRAND_SUMMARY_MAX = 1000;
export const BRAND_LOGO_ALT_MAX = 200;
/** How many proposals of one seller may wait for a decision at once. */
export const MAX_OPEN_PROPOSALS_PER_SELLER = 5;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
/** Control, format and separator characters other than a plain space: never part of a name. */
const HIDDEN_OR_CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

/**
 * A name as it is stored: inner runs of whitespace become one space, the ends are trimmed. The
 * result is what the database CHECK `name = btrim(name)` expects. Not validated here.
 */
export function tidyBrandName(raw: string): string {
  return raw.replace(/\s+/gu, ' ').trim();
}

/**
 * The near-duplicate key of a name: trimmed, lower case, "&" read as "and", letters and digits
 * only. "Fuji & Co.", "FUJI AND CO" and "fuji-and-co" share one key. The migration computes the
 * same key in SQL (`pg_temp.brand_name_key`); the two agree on ASCII letters and digits, which is
 * what the migration test checks.
 */
export function brandNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The slug a name suggests: lower case ASCII words joined by hyphens, accents removed, at most
 * {@link BRAND_SLUG_BASE_MAX} characters; `brand` when nothing is left. The migration derives its
 * slugs the same way, minus the accent step (SQL has no `unaccent` here), so an accented name can
 * get a different slug in the backfill; the slug is stored, never recomputed.
 */
export function suggestBrandSlug(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, BRAND_SLUG_BASE_MAX)
    .replace(/-+$/gu, '');
  return words === '' ? 'brand' : words;
}

export const isBrandSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= BRAND_SLUG_MAX && SLUG_PATTERN.test(value);

/** Whether two spellings are the same brand name apart from case and edge spaces. */
export const sameBrandSpelling = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** One refused field: its path and a stable code. */
export interface BrandFieldProblem {
  readonly path: string;
  readonly code: string;
}

/** The editable content of a brand, validated. */
export interface BrandContent {
  readonly name: string;
  readonly summary: string | null;
  readonly originCountry: string | null;
  readonly logoImageId: string | null;
  readonly logoAlt: string | null;
  readonly headerImageId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function optionalText(
  value: unknown,
  path: string,
  max: number,
  problems: BrandFieldProblem[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push({ path, code: 'type' });
    return null;
  }
  const tidy = tidyBrandName(value);
  if (tidy === '') return null;
  if (tidy.length > max) problems.push({ path, code: 'too-long' });
  else if (HIDDEN_OR_CONTROL.test(tidy)) problems.push({ path, code: 'chars' });
  return tidy;
}

function optionalImageId(
  value: unknown,
  path: string,
  problems: BrandFieldProblem[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) {
    problems.push({ path, code: 'format' });
    return null;
  }
  return value;
}

/**
 * Validates the content fields of a create or an edit. Every field is judged; the problems come
 * back together so a form shows them at once. A logo needs its alt text and alt text needs a logo.
 */
export function parseBrandContent(input: {
  readonly name?: unknown;
  readonly summary?: unknown;
  readonly originCountry?: unknown;
  readonly logoImageId?: unknown;
  readonly logoAlt?: unknown;
  readonly headerImageId?: unknown;
}): Result<BrandContent, readonly BrandFieldProblem[]> {
  const problems: BrandFieldProblem[] = [];
  let name = '';
  if (typeof input.name !== 'string') problems.push({ path: 'name', code: 'required' });
  else {
    name = tidyBrandName(input.name);
    if (name === '') problems.push({ path: 'name', code: 'required' });
    else if (name.length > BRAND_NAME_MAX) problems.push({ path: 'name', code: 'too-long' });
    else if (HIDDEN_OR_CONTROL.test(name)) problems.push({ path: 'name', code: 'chars' });
    else if (brandNameKey(name) === '') problems.push({ path: 'name', code: 'no-letters' });
  }
  const summary = optionalText(input.summary, 'summary', BRAND_SUMMARY_MAX, problems);
  let originCountry: string | null = null;
  if (input.originCountry !== undefined && input.originCountry !== null) {
    if (typeof input.originCountry !== 'string' || !COUNTRY_PATTERN.test(input.originCountry)) {
      problems.push({ path: 'originCountry', code: 'format' });
    } else originCountry = input.originCountry;
  }
  const logoImageId = optionalImageId(input.logoImageId, 'logoImageId', problems);
  const logoAlt = optionalText(input.logoAlt, 'logoAlt', BRAND_LOGO_ALT_MAX, problems);
  const headerImageId = optionalImageId(input.headerImageId, 'headerImageId', problems);
  if (logoImageId !== null && logoAlt === null)
    problems.push({ path: 'logoAlt', code: 'required' });
  if (logoImageId === null && logoAlt !== null) problems.push({ path: 'logoAlt', code: 'no-logo' });
  if (problems.length > 0) return err(problems);
  return ok({ name, summary, originCountry, logoImageId, logoAlt, headerImageId });
}

export interface BrandState {
  readonly id: Id<'Brand'>;
  readonly slug: string;
  readonly name: string;
  readonly nameKey: string;
  readonly logoImageId: string | null;
  readonly logoAlt: string | null;
  readonly headerImageId: string | null;
  readonly summary: string | null;
  readonly originCountry: string | null;
  readonly status: BrandStatus;
  /** The seller who proposed it; null for an admin-created or backfilled brand. */
  readonly proposedBySellerId: Id<'Seller'> | null;
  /** The admin account that created or approved it; null while a draft and for a backfilled brand. */
  readonly approvedBy: Id<'Account'> | null;
  /** Set exactly when a merge archived the brand: the brand that took its products. */
  readonly mergedIntoId: Id<'Brand'> | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  /** Optimistic version: 1 at insert, one more per change. */
  readonly version: number;
}

/** Why a command was refused: a stable code, never data. */
export type BrandRefusal =
  | { readonly code: 'brand.slug-invalid' }
  | { readonly code: 'brand.slug-locked' }
  | { readonly code: 'brand.not-draft' }
  | { readonly code: 'brand.archived' }
  | { readonly code: 'brand.already-archived' }
  | { readonly code: 'brand.merge-into-itself' }
  | { readonly code: 'brand.merge-target-not-active' }
  | { readonly code: 'brand.merge-source-archived' };

/** Who created the brand. */
export type BrandOrigin =
  | { readonly kind: 'admin'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'seller'; readonly sellerId: Id<'Seller'> };

/**
 * The brand aggregate. State is immutable; a command returns the next state through a new
 * instance, so a repository compares `persistedVersion` with the state's version.
 */
export class Brand {
  readonly #state: BrandState;
  readonly #persistedVersion: number | null;

  private constructor(state: BrandState, persistedVersion: number | null) {
    this.#state = Object.freeze({ ...state });
    this.#persistedVersion = persistedVersion;
  }

  get state(): BrandState {
    return this.#state;
  }

  /** The version the row had when it was read; null for a brand that was never stored. */
  get persistedVersion(): number | null {
    return this.#persistedVersion;
  }

  /** Whether the state differs from the stored row. */
  get hasChanges(): boolean {
    return this.#persistedVersion === null || this.#state.version !== this.#persistedVersion;
  }

  static restore(state: BrandState): Brand {
    return new Brand(state, state.version);
  }

  /**
   * A new brand. An admin's brand is `active` at once and records the admin as its approver; a
   * seller's is a `draft` proposal. The slug is the one given (when valid) or the one `slug`
   * suggests from the name; the caller makes it unique.
   */
  static create(input: {
    readonly id: Id<'Brand'>;
    readonly content: BrandContent;
    readonly slug: string;
    readonly origin: BrandOrigin;
    readonly now: Temporal.Instant;
  }): Result<Brand, BrandRefusal> {
    if (!isBrandSlug(input.slug)) return err({ code: 'brand.slug-invalid' });
    const { content, origin } = input;
    return ok(
      new Brand(
        {
          id: input.id,
          slug: input.slug,
          name: content.name,
          nameKey: brandNameKey(content.name),
          logoImageId: content.logoImageId,
          logoAlt: content.logoAlt,
          headerImageId: content.headerImageId,
          summary: content.summary,
          originCountry: content.originCountry,
          status: origin.kind === 'admin' ? 'active' : 'draft',
          proposedBySellerId: origin.kind === 'seller' ? origin.sellerId : null,
          approvedBy: origin.kind === 'admin' ? origin.accountId : null,
          mergedIntoId: null,
          createdAt: input.now,
          updatedAt: input.now,
          version: 1,
        },
        null,
      ),
    );
  }

  /**
   * Replaces the content of a draft or active brand. The slug changes only while the brand is a
   * draft: once public, its URL stays. An archived brand is final.
   */
  edit(input: {
    readonly content: BrandContent;
    readonly slug?: string;
    readonly now: Temporal.Instant;
  }): Result<Brand, BrandRefusal> {
    const state = this.#state;
    if (state.status === 'archived') return err({ code: 'brand.archived' });
    let slug = state.slug;
    if (input.slug !== undefined && input.slug !== state.slug) {
      if (state.status !== 'draft') return err({ code: 'brand.slug-locked' });
      if (!isBrandSlug(input.slug)) return err({ code: 'brand.slug-invalid' });
      slug = input.slug;
    }
    const { content } = input;
    return ok(
      this.#next({
        slug,
        name: content.name,
        nameKey: brandNameKey(content.name),
        logoImageId: content.logoImageId,
        logoAlt: content.logoAlt,
        headerImageId: content.headerImageId,
        summary: content.summary,
        originCountry: content.originCountry,
        updatedAt: input.now,
      }),
    );
  }

  /** `draft` to `active` by an admin: the approval of a proposal. */
  approve(input: {
    readonly accountId: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): Result<Brand, BrandRefusal> {
    if (this.#state.status !== 'draft') return err({ code: 'brand.not-draft' });
    return ok(this.#next({ status: 'active', approvedBy: input.accountId, updatedAt: input.now }));
  }

  /** `draft` or `active` to `archived`. A draft proposal that is turned down is archived too. */
  archive(input: { readonly now: Temporal.Instant }): Result<Brand, BrandRefusal> {
    if (this.#state.status === 'archived') return err({ code: 'brand.already-archived' });
    return ok(this.#next({ status: 'archived', updatedAt: input.now }));
  }

  /**
   * Archives this brand because its products moved to `target`. Allowed for a draft or active
   * source; an archived source only when it was already merged into this same target (a repeat
   * moves the products of a Market that was not served the first time, and changes nothing here).
   * The target must be active and another brand.
   */
  mergeInto(input: {
    readonly target: BrandState;
    readonly now: Temporal.Instant;
  }): Result<Brand, BrandRefusal> {
    const state = this.#state;
    const { target } = input;
    if (target.id === state.id) return err({ code: 'brand.merge-into-itself' });
    if (target.status !== 'active') return err({ code: 'brand.merge-target-not-active' });
    if (state.status === 'archived') {
      return state.mergedIntoId === target.id
        ? ok(this)
        : err({ code: 'brand.merge-source-archived' });
    }
    return ok(this.#next({ status: 'archived', mergedIntoId: target.id, updatedAt: input.now }));
  }

  #next(changes: Partial<BrandState>): Brand {
    return new Brand(
      { ...this.#state, ...changes, version: this.#state.version + 1 },
      this.#persistedVersion,
    );
  }
}

/**
 * The alias a merge records for the source: its name, unless the target already answers to that
 * spelling. (The source's own aliases move to the target as they are.) Null when none is needed.
 */
export function aliasForMergedName(sourceName: string, targetName: string): string | null {
  return sameBrandSpelling(sourceName, targetName) ? null : sourceName;
}

/**
 * The text of a revision's `brand` attribute, trimmed, or null when there is none (or it is not
 * plain text, as in a localizable attribute): what a publish hands to the brand resolver.
 */
export function brandValueOf(attributeValues: Readonly<Record<string, unknown>>): string | null {
  const value = attributeValues['brand'];
  if (typeof value !== 'string') return null;
  const tidy = tidyBrandName(value);
  return tidy === '' ? null : tidy;
}

const FIRST_LETTER = /^[A-Z]$/;

/** The section letter of a name: its first letter without accents in upper case, else `#`. */
export function azLetterOf(name: string): string {
  const first = name
    .trim()
    .normalize('NFKD')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .charAt(0)
    .toUpperCase();
  return FIRST_LETTER.test(first) ? first : '#';
}

/**
 * Brands grouped for the A to Z page: sections `A` to `Z` in order, then `#`; a section holds its
 * brands by name without regard to case or accents, then by slug. Empty sections are left out.
 */
export function groupBrandsAZ<T extends { readonly name: string; readonly slug: string }>(
  brands: readonly T[],
): readonly { readonly letter: string; readonly brands: readonly T[] }[] {
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const sorted = [...brands].sort(
    (a, b) => collator.compare(a.name, b.name) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  const sections = new Map<string, T[]>();
  for (const brand of sorted) {
    const letter = azLetterOf(brand.name);
    const list = sections.get(letter) ?? [];
    list.push(brand);
    sections.set(letter, list);
  }
  const letters = [...sections.keys()].sort((a, b) =>
    a === '#' ? 1 : b === '#' ? -1 : a < b ? -1 : a > b ? 1 : 0,
  );
  return letters.map((letter) => ({ letter, brands: sections.get(letter)! }));
}
