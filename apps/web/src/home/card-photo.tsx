'use client';

import { useState } from 'react';
import { checkLoaded } from '../icons/check-loaded.ts';
import { CategoryArt } from '../icons/category-icon.tsx';

/**
 * The photo of a product card. When the browser cannot load it (the photo was taken down since
 * the page was built, or the image origin is down) the card shows its category illustration
 * instead of a broken image.
 */
export function CardPhoto({ src, category }: { readonly src: string; readonly category: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <CategoryArt code={category} />;
  return (
    <img
      className="photo"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      ref={(el) => checkLoaded(el, () => setBroken(true))}
      onError={() => setBroken(true)}
    />
  );
}
