'use client';

import { useState } from 'react';
import { checkLoaded } from '../icons/check-loaded.ts';
import { CategoryArt } from '../icons/category-icon.tsx';
import type { PhotoSet } from '../storefront/photos.ts';

/**
 * How wide a card is at each width of the screen (the product grid: 2, 3, 4, 6 and 8 columns).
 * Shelves on the home page can be narrower, which only means the browser picks a larger file.
 */
export const CARD_SIZES =
  '(min-width: 1600px) 12vw, (min-width: 1100px) 17vw, (min-width: 900px) 25vw, (min-width: 700px) 34vw, 50vw';

/**
 * The photo of a product card. When the browser cannot load it (the photo was taken down since
 * the page was built, or the image origin is down) the card shows its category illustration
 * instead of a broken image.
 */
export function CardPhoto({
  src,
  category,
  set,
}: {
  readonly src: string;
  readonly category: string;
  readonly set?: PhotoSet | undefined;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <CategoryArt code={category} />;
  return (
    <img
      className="photo"
      src={src}
      {...(set === undefined
        ? {}
        : { srcSet: set.srcSet, sizes: CARD_SIZES, width: set.width, height: set.height })}
      alt=""
      loading="lazy"
      decoding="async"
      ref={(el) => checkLoaded(el, () => setBroken(true))}
      onError={() => setBroken(true)}
    />
  );
}
