import type { ReactNode } from 'react';
import { CATEGORY_ART } from './category-art.tsx';

/** The illustration of a department slug, or the general one for any other code (or none). */
export function categoryArtOf(code: string): ReactNode {
  return Object.hasOwn(CATEGORY_ART, code) ? CATEGORY_ART[code] : CATEGORY_ART.general;
}

/**
 * A category's colour illustration: the stand-in for a product without a photo (cards, the
 * product page, cart, checkout and account lines) and the picture of a department in menus. A
 * code without its own illustration (a deeper category, an unknown or empty code) gets the
 * general one.
 */
export function CategoryArt({ code }: { readonly code: string }) {
  return (
    <svg className="vec" viewBox="0 0 64 64" aria-hidden="true">
      {categoryArtOf(code)}
    </svg>
  );
}
