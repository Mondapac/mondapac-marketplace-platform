import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { normalizeGtin } from '../../domain/variant-gtin';
import type { SellerCategoryScope } from '../business-activities/allowed-category-ids';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  PlatformProductSearchReader,
  PlatformProductSearchRow,
} from '../ports/platform-product-search.reader';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export const PLATFORM_SEARCH_PAGE_SIZE = 25;
export const PLATFORM_SEARCH_MAX_LENGTH = 100;
export const PLATFORM_SEARCH_MAX_PAGE = 200;
/** Barcodes pasted at once. */
export const PLATFORM_SEARCH_MAX_BARCODES = 200;

const KEYS = new Set(['q', 'barcodes', 'page']);

export interface OwnPlatformProductSearchInput {
  /** Free text: name, product code, brand, category or a barcode. */
  readonly q?: unknown;
  /** A pasted list of barcodes (an array of strings); answers `barcodeResults` as well. */
  readonly barcodes?: unknown;
  readonly page?: unknown;
}

export type BarcodeStatus = 'found' | 'already-selling' | 'not-allowed' | 'not-found' | 'invalid';

export interface BarcodeResult {
  /** The line as pasted, trimmed and cut to 40 characters. */
  readonly input: string;
  readonly status: BarcodeStatus;
  readonly product: PlatformProductSearchRow | null;
}

export interface OwnPlatformProductSearchOutput {
  readonly items: readonly PlatformProductSearchRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** `no-activity` when the seller's business activities allow no category. */
  readonly notice: 'no-activity' | null;
  readonly barcodeResults: readonly BarcodeResult[];
}

export type OwnPlatformProductSearchFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnPlatformProductSearchDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly platformSearchReader: PlatformProductSearchReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerCategories: Pick<SellerCategoryScope, 'allowedCategoryIdsForSeller'>;
}

/**
 * `own-product.platform-search`: the seller's search of published PLATFORM products to sell
 * ("Add offer"). Only categories inside the seller's business activities are searched (the shared
 * `allowedCategoryIdsForSeller`; fail closed); a product the seller already sells is returned with
 * `alreadySelling` so the screen cannot select it. A pasted barcode list answers one line each
 * with a reason. Rule: the key `catalog.own-product.edit` (it is the first step of creating an
 * Offer) and the seller population; the seller comes from the actor. Reads only; no price, no stock.
 */
export class OwnPlatformProductSearch extends UseCase<
  OwnPlatformProductSearchInput,
  OwnPlatformProductSearchOutput,
  OwnPlatformProductSearchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-platform-product-search',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnPlatformProductSearchDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnPlatformProductSearchInput,
  ): Promise<Result<OwnPlatformProductSearchOutput, OwnPlatformProductSearchFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const parsed = parse(input);
    if (!parsed.ok) return parsed;
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // Asked before the read unit: the scope opens a unit of its own (units do not nest).
    const allowed = await this.deps.sellerCategories.allowedCategoryIdsForSeller(context, sellerId);
    if (!allowed.ok) return err({ code: 'access.unavailable' });
    const { text, page, lines } = parsed.value;
    const typed = text === null ? null : normalizeGtin(text);
    const gtins = typed !== null && typed.ok ? [typed.value] : [];
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const found = await this.deps.platformSearchReader.search(market, {
          sellerId,
          allowedCategoryIds: allowed.value,
          locale,
          text,
          gtins,
          offset: (page - 1) * PLATFORM_SEARCH_PAGE_SIZE,
          limit: PLATFORM_SEARCH_PAGE_SIZE,
        });
        const valid = lines.flatMap((line) => (line.gtin === null ? [] : [line.gtin]));
        const matches =
          valid.length === 0
            ? []
            : await this.deps.platformSearchReader.lookupGtins(market, {
                sellerId,
                allowedCategoryIds: allowed.value,
                locale,
                gtins: valid,
              });
        return ok({ found, matches });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { found, matches } = read.value;
    const barcodeResults = lines.map((line): BarcodeResult => {
      if (line.gtin === null) return { input: line.input, status: 'invalid', product: null };
      const hits = matches.filter((match) => match.gtin === line.gtin);
      if (hits.length === 0) return { input: line.input, status: 'not-found', product: null };
      const inScope = hits.find((hit) => hit.inScope);
      if (inScope === undefined) return { input: line.input, status: 'not-allowed', product: null };
      return {
        input: line.input,
        status: inScope.row.alreadySelling ? 'already-selling' : 'found',
        product: inScope.row,
      };
    });
    return ok({
      items: found.rows,
      total: found.total,
      page,
      pageSize: PLATFORM_SEARCH_PAGE_SIZE,
      notice: allowed.value.size === 0 ? 'no-activity' : null,
      barcodeResults,
    });
  }
}

interface ParsedSearch {
  readonly text: string | null;
  readonly page: number;
  readonly lines: readonly { readonly input: string; readonly gtin: string | null }[];
}

function parse(input: OwnPlatformProductSearchInput): Result<ParsedSearch, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
  let text: string | null = null;
  if (input.q !== undefined) {
    if (typeof input.q !== 'string') return invalid('q', 'type');
    const trimmed = input.q.trim();
    if (trimmed.length > PLATFORM_SEARCH_MAX_LENGTH) return invalid('q', 'too-long');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return invalid('q', 'invalid');
    text = trimmed === '' ? null : trimmed;
  }
  let page = 1;
  if (input.page !== undefined) {
    const value = typeof input.page === 'string' ? Number(input.page) : input.page;
    if (
      !Number.isInteger(value) ||
      (value as number) < 1 ||
      (value as number) > PLATFORM_SEARCH_MAX_PAGE
    ) {
      return invalid('page', 'range');
    }
    page = value as number;
  }
  const lines: { input: string; gtin: string | null }[] = [];
  if (input.barcodes !== undefined) {
    if (!Array.isArray(input.barcodes)) return invalid('barcodes', 'type');
    if (input.barcodes.length > PLATFORM_SEARCH_MAX_BARCODES)
      return invalid('barcodes', 'too-many');
    const seen = new Set<string>();
    for (const raw of input.barcodes as unknown[]) {
      if (typeof raw !== 'string') return invalid('barcodes', 'type');
      const line = raw.trim();
      if (line === '' || seen.has(line)) continue;
      seen.add(line);
      const normalized = line.length > 40 ? { ok: false as const } : normalizeGtin(line);
      lines.push({
        input: line.slice(0, 40),
        gtin: normalized.ok ? normalized.value : null,
      });
    }
  }
  return ok({ text, page, lines });
}

export type { Id };
