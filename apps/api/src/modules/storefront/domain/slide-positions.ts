// The slider positions of the buyer site: a closed list in code, each with the most slides that
// may be active at once and whether it may autoplay. Checkout, order confirmation and the account
// have no position. Nothing here comes from the database or the request.

export interface PositionDefinition {
  readonly key: string;
  /** Most slides active at one time on one page of the position (see `capExceeded`). */
  readonly maxActive: number;
  /** Autoplay is allowed here (the hero and the top of a landing page); every other position is manual. */
  readonly autoplay: boolean;
  /** The scopes a placement at this position may have. */
  readonly scopes: readonly SlideScope[];
}

export const SLIDE_SCOPES = ['all', 'category', 'product', 'seller', 'page'] as const;
export type SlideScope = (typeof SLIDE_SCOPES)[number];

export const POSITIONS: readonly PositionDefinition[] = [
  { key: 'home.hero', maxActive: 8, autoplay: true, scopes: ['all'] },
  { key: 'home.mid', maxActive: 4, autoplay: false, scopes: ['all'] },
  { key: 'category.top', maxActive: 4, autoplay: false, scopes: ['all', 'category'] },
  {
    key: 'product.below-details',
    maxActive: 3,
    autoplay: false,
    scopes: ['all', 'category', 'product', 'seller'],
  },
  { key: 'cart.below-lines', maxActive: 3, autoplay: false, scopes: ['all'] },
  { key: 'landing.top', maxActive: 8, autoplay: true, scopes: ['all', 'page'] },
];

export const POSITION_KEYS = POSITIONS.map((position) => position.key) as readonly string[];

export const positionOf = (key: string): PositionDefinition | null =>
  POSITIONS.find((position) => position.key === key) ?? null;
