import type { ImgHTMLAttributes, Ref } from 'react';
import type { PhotoSet } from './photos.ts';

/**
 * A product photo: a `<picture>` with an AVIF and a WebP source ahead of the JPEG `<img>` when the
 * photo has a set, so a browser takes the newest format it knows and any other gets the JPEG. The
 * `<img>` carries everything else (alt, size, loading, error handling) and keeps the JPEG `src`.
 * A photo without a set (a placeholder or sample) is the plain `<img>` it always was.
 */
export function PhotoImage({
  set,
  sizes,
  imgRef,
  ...img
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'srcSet' | 'sizes'> & {
  readonly set?: PhotoSet | undefined;
  readonly sizes: string;
  readonly imgRef?: Ref<HTMLImageElement>;
}) {
  if (set === undefined) return <img {...img} ref={imgRef} alt={img.alt ?? ''} />;
  const tag = <img {...img} ref={imgRef} srcSet={set.srcSet} sizes={sizes} alt={img.alt ?? ''} />;
  if (set.sources.length === 0) return tag;
  return (
    <picture>
      {set.sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={sizes} />
      ))}
      {tag}
    </picture>
  );
}
