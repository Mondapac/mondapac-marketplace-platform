'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StoreImage } from '../storefront/types.ts';

// The store's own pictures on the buyer site. A picture that fails to load (the file went away, the
// API is down) must not leave a broken-image box: the logo falls back to the default store tile and
// the banner to the neutral banner. Both are decoration beside the store name, so their alt text is
// empty (the name is the page heading).

/**
 * Calls `onFailed` when the picture had already failed before React attached `onError` (server
 * rendered markup that the browser loaded before hydration): a finished load with no width.
 */
function useFailedBeforeHydration(onFailed: () => void) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img !== null && img.complete && img.naturalWidth === 0) onFailed();
  }, [onFailed]);
  return ref;
}

/** The logo tile with the store's picture, or `fallback` (the default tile) once it fails to load. */
export function LogoPicture({
  image,
  fallback,
}: {
  readonly image: StoreImage;
  readonly fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const markFailed = () => setFailed(true);
  const ref = useFailedBeforeHydration(markFailed);
  if (failed) return fallback;
  return (
    <span className="lg lg-img">
      <img
        ref={ref}
        src={image.src}
        width={image.width}
        height={image.height}
        alt=""
        decoding="async"
        onError={markFailed}
      />
    </span>
  );
}

/** The banner of the header card, with its Share pill sibling outside; the neutral banner on failure. */
export function BannerPicture({ image }: { readonly image: StoreImage | undefined }) {
  const [failed, setFailed] = useState(false);
  const markFailed = () => setFailed(true);
  const ref = useFailedBeforeHydration(markFailed);
  const shown = image !== undefined && !failed;
  return (
    <div className={shown ? 'shop-banner has-image' : 'shop-banner'}>
      {shown ? (
        <img
          ref={ref}
          src={image.src}
          width={image.width}
          height={image.height}
          alt=""
          decoding="async"
          onError={markFailed}
        />
      ) : null}
    </div>
  );
}
