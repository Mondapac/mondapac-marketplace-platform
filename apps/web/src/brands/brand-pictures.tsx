'use client';

import { useEffect, useRef, useState } from 'react';
import type { BrandImage } from '../storefront/types.ts';

// The brand's own pictures on the buyer site. A picture that fails to load (the file went away, the
// API is down) must not leave a broken-image box: the logo falls back to the monogram tile and the
// header to the neutral header bar. The logo is content (it is the only mark of a brand in a grid of
// logos), so it carries the alt text the brand's admin wrote; the header is decoration, so its alt is
// empty.

/** Calls `onFailed` when the picture had already failed before React attached `onError`. */
function useFailedBeforeHydration(onFailed: () => void) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img !== null && img.complete && img.naturalWidth === 0) onFailed();
  }, [onFailed]);
  return ref;
}

/** Up to two capital letters of the name's words: "Saffron & Co" is "SC". */
export function monogramOf(name: string): string {
  const letters = Array.from(name.matchAll(/[\p{L}\p{N}]+/gu), (word) => Array.from(word[0])[0]!);
  const first = letters[0];
  if (first === undefined) return '?';
  const last = letters.length > 1 ? letters[letters.length - 1] : undefined;
  return `${first}${last ?? ''}`.toLocaleUpperCase();
}

/**
 * The brand's logo tile: the picture with its alt text, or the monogram of the name (decoration:
 * the name is written beside it). `size` picks the tile's size class.
 */
export function BrandLogo({
  name,
  logo,
  size,
}: {
  readonly name: string;
  readonly logo?: (BrandImage & { readonly alt: string }) | undefined;
  readonly size: 'sm' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const markFailed = () => setFailed(true);
  const ref = useFailedBeforeHydration(markFailed);
  if (logo === undefined || failed)
    return (
      <span className={`br-mark ${size}`} aria-hidden="true">
        {monogramOf(name)}
      </span>
    );
  return (
    <span className={`br-mark img ${size}`}>
      <img
        ref={ref}
        src={logo.src}
        width={logo.width}
        height={logo.height}
        alt={logo.alt}
        decoding="async"
        onError={markFailed}
      />
    </span>
  );
}

/** The header picture of a brand page; the neutral bar (mist) when there is none or it fails. */
export function BrandHeaderPicture({ image }: { readonly image: BrandImage | undefined }) {
  const [failed, setFailed] = useState(false);
  const markFailed = () => setFailed(true);
  const ref = useFailedBeforeHydration(markFailed);
  const shown = image !== undefined && !failed;
  return (
    <div className={shown ? 'br-cover has-image' : 'br-cover'}>
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
