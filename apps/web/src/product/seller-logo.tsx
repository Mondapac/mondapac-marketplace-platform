import { ICON_PATHS } from '../icons/icon-paths.tsx';
import { SAMPLE_SELLER_ART } from '../icons/seller-art.tsx';
import { LogoPicture } from '../seller/store-picture.tsx';
import type { StoreImage } from '../storefront/types.ts';

/**
 * A seller's logo tile; a seller without a profile logo gets the store icon on a mist tile. A
 * picture the store uploaded (`image`) fills the tile instead, with its pixels set so the page does
 * not jump (and falls back to the tile if it fails to load). The tile is decoration: the store's
 * name is always written beside it, so the picture has an empty alt.
 */
export function SellerLogo({
  logo,
  image,
}: {
  readonly logo: string | undefined;
  readonly image?: StoreImage | undefined;
}) {
  const art = logo === undefined ? undefined : SAMPLE_SELLER_ART[logo];
  const tile = (
    <span className="lg" aria-hidden="true">
      <svg className="lgv" viewBox="0 0 64 64">
        {art ?? (
          <>
            <rect width="64" height="64" rx="16" fill="var(--sf-mist)" />
            <g
              transform="translate(16 16) scale(1.33)"
              fill="none"
              stroke="var(--sf-teal)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {ICON_PATHS.store}
            </g>
          </>
        )}
      </svg>
    </span>
  );
  return image === undefined ? tile : <LogoPicture image={image} fallback={tile} />;
}
