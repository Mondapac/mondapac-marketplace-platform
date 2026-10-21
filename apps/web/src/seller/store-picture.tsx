'use client';

import { useState, type ReactNode } from 'react';
import type { StoreImage } from '../storefront/types.ts';

// The store's own pictures on the buyer site. A picture that fails to load (the file went away, the
// API is down) must not leave a broken-image box: the logo falls back to the default store tile and
// the banner to the neutral banner. Both are decoration beside the store name, so their alt text is
// empty (the name is the page heading).

/** The logo tile with the store's picture, or `fallback` (the default tile) once it fails to load. */
export function LogoPicture({
  image,
  fallback,
}: {
  readonly image: StoreImage;
  readonly fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <span className="lg lg-img">
      <img
        src={image.src}
        width={image.width}
        height={image.height}
        alt=""
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

/** The banner of the header card, with its Share pill sibling outside; the neutral banner on failure. */
export function BannerPicture({ image }: { readonly image: StoreImage | undefined }) {
  const [failed, setFailed] = useState(false);
  const shown = image !== undefined && !failed;
  return (
    <div className={shown ? 'shop-banner has-image' : 'shop-banner'}>
      {shown ? (
        <img
          src={image.src}
          width={image.width}
          height={image.height}
          alt=""
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}
