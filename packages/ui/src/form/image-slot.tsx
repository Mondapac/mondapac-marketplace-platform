import type { ReactNode } from 'react';

export type ImageSlotShape = 'square' | 'banner';

export interface ImageSlotProps {
  /** "No logo yet." */
  readonly children: ReactNode;
  /** square: a logo tile; banner: a wide strip. */
  readonly shape?: ImageSlotShape;
}

const SHAPE: Record<ImageSlotShape, string> = {
  square: 'size-24 p-2',
  banner: 'min-h-24 w-full p-4',
};

/**
 * The empty state of a picture slot (a logo, a banner): a dashed frame with centred text. It
 * holds the place of the picture, so the card does not jump when one is chosen.
 */
export function ImageSlot({ children, shape = 'banner' }: ImageSlotProps) {
  return (
    <div
      className={`flex items-center justify-center rounded-md border border-dashed border-line text-center text-sm text-fg-muted ${SHAPE[shape]}`}
    >
      <p>{children}</p>
    </div>
  );
}
