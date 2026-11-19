'use client';

import { useState } from 'react';
import { Icon } from '../icon/icon.tsx';

/** A product photo as a small square, or a package tile when there is none or it cannot be shown. */
export function ListThumb({ src }: { readonly src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-icon"
      >
        <Icon name="package" />
      </span>
    );
  }
  return (
    // The panel's relay serves the photo from the same origin, with the session.
    <img
      src={src}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-10 shrink-0 rounded-md bg-muted object-cover"
    />
  );
}
