// What the header search's suggestions panel shows. The BFF route (app/api/search-suggest) builds
// this from the API's `GET search/suggest` answer: links and photo URLs are made on the server
// from checked ids, so the browser never needs the API's address and a body never names a link.
// No price and no certification text: suggestions carry neither (search-suggestions handoff).

export interface SuggestProduct {
  readonly id: string;
  readonly name: string;
  /** The product page. */
  readonly href: string;
  /** "seller . category"; just the seller when the product has no category. */
  readonly sellerName: string;
  readonly categoryName: string | null;
  /** The thumbnail URL; null shows the placeholder tile. */
  readonly imageUrl: string | null;
}

export interface SuggestStore {
  readonly slug: string;
  /** The seller page. */
  readonly href: string;
  readonly name: string;
  readonly productCount: number;
}

export interface SuggestAnswer {
  readonly products: readonly SuggestProduct[];
  readonly stores: readonly SuggestStore[];
  /** Products matching the words; "N+" when {@link totalIsCapped}. */
  readonly total: number;
  readonly totalIsCapped: boolean;
}

/** The route's path; the hook in ./use-suggest.ts reads it. */
export const SUGGEST_PATH = '/api/search-suggest';
